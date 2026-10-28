// Runs the grader's CLI on the theta and iota chunks under fixtures/: coordinators that launched
// through bg_start with their output redirected to files, retried a launch, wrote bare PR numbers
// and scratch files, and handed off to a new session. A stub `gh` stands on a PATH that cannot
// reach the real one, beside the real `git`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  fixtureRoot,
  grade,
  id,
  placeFixtures,
  type Rows,
  readTsv,
  type Run,
  stubGh,
} from "./harness.ts";

const UNRELATED = id("9");

const THETA = id("c008");

const THETA_HANDOFF = id("c009");

const THETA_VERIFIER = id("b1");

const THETA_IMPLEMENTER = id("b2");

const THETA_REVIEWERS = [id("b4"), id("b5")];

/** A session from before theta's launches that carries the name its implementer launch gives. */
const EARLIER_NAMESAKE = id("b3");

/** The path of the session file of `session` under the placed fixtures at `root`. */
function sessionFile(root: string, session: string): string {
  const dir = join(root, "session-files/--work--");
  const name = readdirSync(dir).find((entry) => entry.endsWith(`_${session}.jsonl`));

  assert.ok(name, `no session file for ${session}`);

  return join(dir, name);
}

const SHA17 = "abc1234".padEnd(40, "0");

interface ThetaGrade {
  readonly root: string;
  readonly run: Run;
  readonly sessions: Rows;
  readonly findings: Rows;
}

const ledger = (root: string) => `${root}/state/demo/implement-chunk/theta/ledger.tsv`;

/** A ledger row for `pr` verified by unit tests at an unmerged head. */
const verifiedRow = (pr: string) =>
  `${pr}\t${"8".repeat(40)}\tunit-test-verified\tevidence/${pr}/\t2026-01-09T06:00:00.000Z\n`;

/** The findings of one class, each as its session, entry, and detail. */
const rows = (graded: ThetaGrade, findingClass: string) =>
  graded.findings
    .filter((row) => row.class === findingClass)
    .map((row) => `${row.session} ${row.entry} ${row.detail}`)
    .toSorted();

/** {@link rows}, with the placed fixtures' root written as `<root>`. */
const relative = (graded: ThetaGrade, findingClass: string) =>
  rows(graded, findingClass).map((row) => row.replaceAll(graded.root, "<root>"));

describe("grading a coordinator that launched through bg_start into files, wrote bare PR numbers and scratch files, and handed off", () => {
  const placed: string[] = [];

  /** Grades theta, after `prepare` changes the placed fixtures under the root it is given. */
  function gradeTheta(prepare: (root: string) => void = () => {}): ThetaGrade {
    const root = fixtureRoot();
    const stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));

    placed.push(root, stubDir);
    placeFixtures(root);
    stubGh(stubDir);

    // Neither the unrelated session nor the earlier namesake is a session theta started: a grader
    // that read one past its first user message would fail or never finish.
    truncateSync(sessionFile(root, UNRELATED), 4 * 1024 ** 3);
    truncateSync(sessionFile(root, EARLIER_NAMESAKE), 4 * 1024 ** 3);
    prepare(root);

    const run = grade(root, stubDir, join(root, "out"), "theta");

    assert.equal(run.status, 0, run.stderr);

    return {
      root,
      run,
      sessions: readTsv(join(root, "out/sessions.tsv")),
      findings: readTsv(join(root, "out/findings.tsv")),
    };
  }

  let theta: ThetaGrade;

  before(() => {
    theta = gradeTheta();
  });

  after(() => {
    for (const dir of placed) rmSync(dir, { recursive: true, force: true });
  });

  // q0000007 starts two reviewers under one name in one command, before either child starts.
  test("a launch whose output went to files is joined to the child session the launcher named, and every child is graded", () => {
    assert.deepEqual(
      rows(theta, "launch"),
      [
        `${THETA} q0000001 kind=delegate role=verifier depth=1 child=${THETA_VERIFIER}`,
        `${THETA} q0000002 kind=delegate role=implementer depth=1 child=${THETA_IMPLEMENTER}`,
        ...THETA_REVIEWERS.map(
          (reviewer) => `${THETA} q0000007 kind=delegate role=persona depth=1 child=${reviewer}`,
        ),
      ].toSorted(),
    );
    assert.deepEqual(
      theta.sessions
        .filter((row) => row.mode === "subagent")
        .map((row) => [row.session, row.chunk, row.role, row.parent, row.depth].join(" ")),
      [
        `${THETA_VERIFIER} theta verifier ${THETA} 1`,
        `${THETA_IMPLEMENTER} theta implementer ${THETA} 1`,
        ...THETA_REVIEWERS.map((reviewer) => `${reviewer} theta persona ${THETA} 1`),
      ],
    );
    assert.doesNotMatch(theta.run.stdout, /no child session/);
  });

  test("a session the coordinators did not start stays unread, though it shares a child's name", () => {
    const graded = new Set([...theta.sessions, ...theta.findings].map((row) => row.session));

    assert.ok(!graded.has(EARLIER_NAMESAKE), "the earlier namesake was graded");
    assert.ok(!graded.has(UNRELATED), "the unrelated session was graded");
  });

  test("a bare PR number resolves against the origin of the coordinator's repository, as the same ledger with owner/repo#n does", () => {
    const qualified = gradeTheta((root) => {
      const path = ledger(root);

      writeFileSync(path, readFileSync(path, "utf8").replace(/^(1[78])\t/gm, "acme/app#$1\t"));
    });

    for (const graded of [theta, qualified]) {
      assert.doesNotMatch(graded.run.stderr, /no pull request/);
      assert.deepEqual(
        graded.findings
          .filter((row) => row.class === "stale-verdict" || row.class === "report-only-merge")
          .map((row) => `${row.class} ${row.detail}`)
          .toSorted(),
        [
          `report-only-merge acme/app#17 ${SHA17} ${ledger(graded.root)}:3`,
          `stale-verdict acme/app#18 ${ledger(graded.root)}:2`,
        ],
      );
    }

    for (const findingClass of ["stale-verdict", "report-only-merge"]) {
      assert.deepEqual(relative(theta, findingClass), relative(qualified, findingClass));
    }
  });

  test("a bare PR number resolves against the repository the state files name in full, before the coordinator's origin", () => {
    // The coordinator ran in a harness checkout, and one ledger row names the product's
    // repository in full.
    const harness = gradeTheta((root) => {
      const path = ledger(root);

      execFileSync("git", [
        "-C",
        join(root, "repo"),
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/harness.git",
      ]);
      writeFileSync(path, `${readFileSync(path, "utf8")}${verifiedRow("acme/app#16")}`);
    });

    assert.doesNotMatch(harness.run.stderr, /no pull request/);
    assert.deepEqual(relative(harness, "report-only-merge"), relative(theta, "report-only-merge"));
  });

  test("a bare PR number stays unresolved when the state files name several repositories in full, whatever the coordinator's origin", () => {
    const spread = gradeTheta((root) => {
      const path = ledger(root);

      execFileSync("git", [
        "-C",
        join(root, "repo"),
        "remote",
        "set-url",
        "origin",
        "https://github.com/acme/harness.git",
      ]);
      writeFileSync(
        path,
        `${readFileSync(path, "utf8")}${verifiedRow("acme/app#16")}${verifiedRow("acme/lib#3")}`,
      );
    });

    assert.match(spread.run.stderr, /ledger\.tsv:3: no pull request in "17"/);
    assert.doesNotMatch(spread.run.stderr, /acme\/harness/);
  });

  test("a write under /tmp or the temp directory is no root edit, and one in the repository is", () => {
    assert.deepEqual(rows(theta, "root-edit"), [`${THETA} q0000005 ${theta.root}/repo/src/app.ts`]);
  });

  test("a handoff session is graded as a coordinator of the chunk it continues, and a row it wrote names its entry", () => {
    assert.deepEqual(
      theta.sessions
        .filter((row) => row.role === "coordinator")
        .map((row) => [row.session, row.chunk, row.mode, row.parent, row.depth].join(" ")),
      [`${THETA} theta general - 0`, `${THETA_HANDOFF} theta general ${THETA} 0`],
    );
    assert.deepEqual(rows(theta, "report-only-merge"), [
      `${THETA_HANDOFF} h0000001 acme/app#17 ${SHA17} ${theta.root}/state/demo/implement-chunk/theta/ledger.tsv:3`,
    ]);
    assert.deepEqual(rows(theta, "stale-verdict"), [
      `${THETA} q0000006 acme/app#18 ${theta.root}/state/demo/implement-chunk/theta/ledger.tsv:2`,
    ]);
  });
});

describe("grading a coordinator that retried a launch under the same name", () => {
  // i00000a1 started no child session; i00000a2, half an hour later, started b6.
  test("the retry takes the child session, and the try before it none", () => {
    const root = fixtureRoot();
    const stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));

    try {
      placeFixtures(root);
      stubGh(stubDir);

      const run = grade(root, stubDir, join(root, "out"), "iota");

      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(
        readTsv(join(root, "out/findings.tsv"))
          .filter((row) => row.class === "launch")
          .map((row) => `${row.entry} ${row.detail}`),
        [
          "i00000a1 kind=delegate role=verifier depth=1 child=unknown",
          `i00000a2 kind=delegate role=verifier depth=1 child=${id("b6")}`,
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

describe("reading a bare pull request number's repository through git", () => {
  test("cannot run without git when a bare number needs the coordinator's repository, and says so with exit 2", () => {
    const root = fixtureRoot();
    const stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));

    try {
      placeFixtures(root);
      stubGh(stubDir);
      rmSync(join(stubDir, "git"));

      const run = grade(root, stubDir, join(root, "out"), "theta");

      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /git is not on PATH/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
