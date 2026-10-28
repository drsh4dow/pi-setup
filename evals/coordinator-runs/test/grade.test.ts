// Runs the grader's CLI on the synthetic chunk under fixtures/, with a stub `gh` on a PATH that
// cannot reach the real one, and checks each count it writes.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  type GhAnswer,
  grade,
  id,
  notFound,
  placeFixtures,
  type Rows,
  readTsv,
  type Run,
  stubGh,
} from "./harness.ts";

const COORDINATOR = id("c001");

const SH4DOW = id("c002");

const BETA = id("c003");

const IMPLEMENTER = id("1");

const BABYSITTER = id("2");

const VERIFIER = id("3");

const NESTED_OWNER = id("4");

const DEEP = id("5");

const EXPLORER = id("6");

const UNRELATED = id("9");

const GAMMA = id("c004");

const DELTA = id("c005");

function skillTable(sessions: Rows, session: string) {
  const row = sessions.find((candidate) => candidate.session === session);

  return row && [row.skill_table_chars, row.skill_table_tokens, row.skill_table_tokens_source];
}

describe("grading a synthetic chunk", () => {
  let root = "";
  let stubDir = "";
  let run: Run;
  let sessions: Rows = [];
  let findings: Rows = [];

  const found = (findingClass: string) =>
    findings
      .filter((row) => row.class === findingClass)
      .map((row) => `${row.session} ${row.entry} ${row.detail}`)
      .toSorted();

  before(() => {
    root = mkdtempSync(join(tmpdir(), "coordinator-runs-"));
    stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));
    placeFixtures(root);
    stubGh(stubDir);

    // The unrelated session gets a 4 GiB sparse tail after its body: a grader that reads it past
    // its first user message fails or never finishes.
    const unrelated = readdirSync(join(root, "session-files/--work--")).find((name) =>
      name.endsWith(`_${UNRELATED}.jsonl`),
    );

    assert.ok(unrelated);
    truncateSync(join(root, "session-files/--work--", unrelated), 4 * 1024 ** 3);

    run = grade(root, stubDir, join(root, "out"));
    assert.equal(run.status, 0, run.stderr);
    sessions = readTsv(join(root, "out/sessions.tsv"));
    findings = readTsv(join(root, "out/findings.tsv"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  });

  test("grades the chunk's coordinator sessions and the subagent tree they launched, nothing else", () => {
    assert.deepEqual(
      sessions.map((row) =>
        [row.session, row.project, row.chunk, row.mode, row.role, row.parent, row.depth].join(" "),
      ),
      [
        `${COORDINATOR} demo alpha general coordinator - 0`,
        `${IMPLEMENTER} demo alpha subagent implementer ${COORDINATOR} 1`,
        `${BABYSITTER} demo alpha subagent babysitter ${COORDINATOR} 1`,
        `${NESTED_OWNER} demo alpha subagent babysitter ${BABYSITTER} 2`,
        `${DEEP} demo alpha subagent implementer ${NESTED_OWNER} 3`,
        `${EXPLORER} demo alpha subagent explorer ${COORDINATOR} 1`,
        `${VERIFIER} demo alpha subagent verifier ${COORDINATOR} 1`,
        `${SH4DOW} demo alpha sh4dow coordinator - 0`,
      ],
    );

    for (const row of sessions) assert.ok(row.file.endsWith(`_${row.session}.jsonl`), row.file);

    const graded = new Set([...sessions, ...findings].map((row) => row.session));

    assert.ok(!graded.has(UNRELATED), "the unrelated session was graded");
    assert.ok(!graded.has(BETA), "the coordinator of an ungraded chunk was graded");
  });

  test("measures the skill table each session ran with, as an estimate", () => {
    assert.deepEqual(skillTable(sessions, COORDINATOR), ["400", "100", "estimate"]);
    assert.deepEqual(skillTable(sessions, SH4DOW), ["0", "0", "estimate"]);
  });

  test("lists each session's skill reads", () => {
    assert.deepEqual(
      found("skill-read"),
      [
        `${VERIFIER} w0000001 principle-prove-it-works`,
        `${COORDINATOR} c0000001 subagents`,
        `${SH4DOW} m0000003 babysit`,
        `${IMPLEMENTER} i0000001 tdd`,
      ].toSorted(),
    );
    assert.equal(sessions.find((row) => row.session === IMPLEMENTER)?.skills_read, "tdd");
  });

  test("lists each launch with kind, role, depth, and child, from codemode, bash, and bg_start, not from a heredoc", () => {
    assert.deepEqual(
      found("launch"),
      [
        `${COORDINATOR} c0000002 kind=delegate role=implementer depth=1 child=${IMPLEMENTER}`,
        `${COORDINATOR} c0000002 kind=owner role=babysitter depth=1 child=${BABYSITTER}`,
        `${COORDINATOR} c0000002 kind=delegate role=explorer depth=1 child=${EXPLORER}`,
        `${COORDINATOR} c0000004 kind=delegate role=verifier depth=1 child=${VERIFIER}`,
        `${COORDINATOR} c0000010 kind=delegate role=pr-writer depth=1 child=unknown`,
        `${IMPLEMENTER} i0000003 kind=delegate role=explorer depth=2 child=unknown`,
        `${BABYSITTER} o0000001 kind=owner role=babysitter depth=2 child=${NESTED_OWNER}`,
        `${NESTED_OWNER} v0000001 kind=delegate role=implementer depth=3 child=${DEEP}`,
      ].toSorted(),
    );
  });

  test("flags a launch from a delegate, an owner launched by an owner, and depth over 2", () => {
    const wrong = findings
      .filter((row) => row.class === "wrong-spawn")
      .map((row) => `${row.session} ${row.entry}`)
      .toSorted();

    assert.deepEqual(
      wrong,
      [`${IMPLEMENTER} i0000003`, `${BABYSITTER} o0000001`, `${NESTED_OWNER} v0000001`].toSorted(),
    );
  });

  test("flags a coordinator's edit outside its state folder, not one inside it, under its renamed project, or a subagent's", () => {
    assert.deepEqual(
      found("root-edit").filter((row) => row.includes(" c0000006 ")),
      [`${COORDINATOR} c0000006 ${root}/work/src/app.ts`],
    );
  });

  test("flags a coordinator's shell write outside its state folder: a redirection, tee, sed -i, or a cp or mv target", () => {
    assert.deepEqual(
      found("root-edit").filter((row) => !row.includes(" c0000006 ")),
      [
        `${COORDINATOR} c0000018 ${root}/work/src/gen.ts`,
        `${COORDINATOR} c0000018 ${root}/work/lib/notes.txt`,
        `${COORDINATOR} c0000018 ${root}/work/src/app.ts`,
        `${COORDINATOR} c0000018 ${root}/work/dist/app.ts`,
        `${COORDINATOR} c0000018 ${root}/work/out.txt`,
        `${COORDINATOR} c0000019 ${root}/state/demo/implement-chunk/beta/units.tsv`,
      ].toSorted(),
    );
  });

  test("flags a verdict at a head the PR did not merge at, unless a carry row covers the merged head", () => {
    assert.deepEqual(found("stale-verdict"), [
      `${COORDINATOR} c0000007 acme/app#7 ${root}/state/demo/implement-chunk/alpha/ledger.tsv:2`,
    ]);
  });

  test("flags a merged final PR whose merged head no verifier session's verdict names, at the entry that wrote its verdict row", () => {
    assert.deepEqual(found("report-only-merge"), [
      `${COORDINATOR} c0000015 acme/app#10 ${"f".repeat(40)} ${root}/state/demo/implement-chunk/alpha/ledger.tsv:6`,
    ]);
  });

  // c0000014 wrote final-10's row last by time; c002, a later session file, wrote it earlier, and
  // c0000019 only printed a chunk CLI call and wrote beta's units.tsv.
  test("flags units left running after a launch, but not a planned unit nobody launched, at the entry that last changed the row", () => {
    assert.deepEqual(found("unterminated-subagent"), [
      `${COORDINATOR} - babysit-9 running ${root}/state/demo/implement-chunk/alpha/units.tsv:4`,
      `${COORDINATOR} c0000014 final-10 pr-open ${root}/state/demo/implement-chunk/alpha/units.tsv:6`,
    ]);
  });

  test("counts the state-row findings no graded session entry wrote", () => {
    assert.match(run.stdout, /1 state-row finding names no entry/);
  });

  test("records the command that produced the output", () => {
    assert.equal(
      readFileSync(join(root, "out/command.txt"), "utf8").trim(),
      `node evals/coordinator-runs/grade.ts --sessions ${root}/session-files --state ${root}/state/demo/implement-chunk/alpha --out ${root}/out`,
    );
  });

  test("prints each graded session with its mode, skill table, and counts", () => {
    for (const row of sessions) assert.match(run.stdout, new RegExp(row.session));

    assert.match(run.stdout, /stale-verdict\s+1/);
  });

  test("a launch call refused before it ran, which started no child session, is no launch", () => {
    assert.ok(!findings.some((row) => row.entry === "c0000020"), JSON.stringify(findings));
  });

  test("grades a coordinator of another chunk only when that chunk is graded", () => {
    assert.ok(!sessions.some((row) => row.session === GAMMA));
  });

  test("cannot run without gh when the chunk names pull requests, and says so with exit 2", () => {
    const empty = mkdtempSync(join(tmpdir(), "coordinator-runs-nogh-"));

    try {
      const failed = grade(root, empty, join(empty, "out"));

      assert.equal(failed.status, 2);
      assert.match(failed.stderr, /gh/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("grading a resumed coordinator whose terminal ids repeat", () => {
  let root = "";
  let stubDir = "";
  let run: Run;
  let sessions: Rows = [];
  let findings: Rows = [];

  before(() => {
    root = mkdtempSync(join(tmpdir(), "coordinator-runs-"));
    stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));
    placeFixtures(root);
    stubGh(stubDir);

    run = grade(root, stubDir, join(root, "out"), "gamma");

    assert.equal(run.status, 0, run.stderr);
    sessions = readTsv(join(root, "out/sessions.tsv"));
    findings = readTsv(join(root, "out/findings.tsv"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  });

  // g0000010 writes the launcher wrapper; g0000008 names launchers in quotes and as arguments.
  const NOT_LAUNCHES = new Set(["g0000010", "g0000008"]);

  const launches = (keep: (entry: string) => boolean) =>
    findings
      .filter((row) => row.class === "launch" && keep(row.entry))
      .map((row) => `${row.session} ${row.entry} ${row.detail}`);

  test("a launcher written to a file, quoted, or named as an argument or redirection target is no launch", () => {
    assert.deepEqual(
      launches((entry) => NOT_LAUNCHES.has(entry)),
      [],
    );
  });

  test("each launch keeps its own command and child, and a watcher on a reused id is no launch", () => {
    assert.deepEqual(
      launches((entry) => !NOT_LAUNCHES.has(entry)),
      [
        `${GAMMA} g0000001 kind=delegate role=unknown depth=1 child=unknown`,
        `${GAMMA} g0000002 kind=delegate role=unknown depth=1 child=${id("a1")}`,
        `${GAMMA} g0000003 kind=delegate role=unknown depth=1 child=${id("a2")}`,
        `${GAMMA} g0000007 kind=owner role=unknown depth=1 child=${id("a3")}`,
        `${GAMMA} g0000012 kind=delegate role=unknown depth=1 child=${id("a4")}`,
        `${GAMMA} g0000013 kind=delegate role=unknown depth=1 child=${id("a5")}`,
        `${GAMMA} g0000014 kind=owner role=unknown depth=1 child=${id("a6")}`,
        `${GAMMA} g0000015 kind=delegate role=implementer depth=1 child=${id("a7")}`,
      ],
    );
  });

  test("a raw pi-subagent launch is graded with the kind its prompt names, and its session joins the tree", () => {
    assert.ok(
      sessions.some(
        (row) =>
          [row.session, row.chunk, row.mode, row.parent, row.depth].join(" ") ===
          `${id("a6")} gamma subagent ${GAMMA} 1`,
      ),
      JSON.stringify(sessions),
    );
  });

  test("says a count of one in the singular", () => {
    assert.match(run.stdout, /^ {2}1 launch names no child session,/m);
  });

  // g0000011's script wrote a brief whose full arguments codemode left out, then units.tsv in full.
  test("a units row links to the codemode call that wrote it in full, though a sibling call's arguments were left out", () => {
    assert.deepEqual(
      findings
        .filter((row) => row.class === "unterminated-subagent")
        .map((row) => `${row.session} ${row.entry} ${row.detail}`),
      [`${GAMMA} g0000011 lv-b running ${root}/state/demo/implement-chunk/gamma/units.tsv:4`],
    );
  });
});

describe("grading a coordinator whose codemode calls were recorded only by size", () => {
  let root = "";
  let stubDir = "";
  let run: Run;
  let sessions: Rows = [];
  let findings: Rows = [];

  before(() => {
    root = mkdtempSync(join(tmpdir(), "coordinator-runs-"));
    stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));
    placeFixtures(root);
    stubGh(stubDir);

    run = grade(root, stubDir, join(root, "out"), "delta");

    assert.equal(run.status, 0, run.stderr);
    sessions = readTsv(join(root, "out/sessions.tsv"));
    findings = readTsv(join(root, "out/findings.tsv"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  });

  // d0000001's script ran two dry runs; codemode kept the second's arguments only cut short,
  // ending before `--dry-run`. d0000002's script launched a verifier recorded the same way, and
  // its terminal reported the child session.
  test("a launch call whose cut command started no child session is a warning naming its entry, not a launch", () => {
    assert.deepEqual(
      findings
        .filter((row) => row.class === "launch")
        .map((row) => `${row.session} ${row.entry} ${row.detail}`),
      [`${DELTA} d0000002 kind=delegate role=verifier depth=1 child=${id("d1")}`],
    );

    const warnings = run.stderr.split("\n").filter((line) => line.includes("d0000001"));

    assert.equal(warnings.length, 1, run.stderr);
    assert.ok(warnings[0].startsWith(`${root}/session-files/--work--/`), warnings[0]);
    assert.match(warnings[0], new RegExp(`_${DELTA}\\.jsonl: entry d0000001: `));
    assert.match(run.stdout, /1 launch call not counted/);
  });

  test("a unit state is terminal by its first word, which ends at a `-`, `(`, space, or other non-letter", () => {
    assert.deepEqual(
      findings
        .filter((row) => row.class === "unterminated-subagent")
        .map((row) => `${row.session} ${row.entry} ${row.detail}`),
      [`${DELTA} d0000003 r1 running bt-1 ${root}/state/demo/implement-chunk/delta/units.tsv:4`],
    );
  });

  test("a planned unit nobody launched is not unterminated, whatever follows its first word", () => {
    assert.ok(!findings.some((row) => row.detail.startsWith("p1 ")), JSON.stringify(findings));
  });

  test("a warning about an uncounted launch call names its session file and entry, never its command", () => {
    assert.match(run.stderr, /d0000001/);
    assert.ok(!run.stderr.includes("SYNTHETICMARKER"), run.stderr);
    assert.ok(!run.stderr.includes("--role implementer"), run.stderr);
  });

  test("says a count of one session in the singular", () => {
    assert.match(run.stdout, /^demo\/delta: 1 session$/m);
  });

  test("rounds the skill table's token estimate up", () => {
    // 37 characters: `<available_skills></available_skills>`.
    assert.deepEqual(skillTable(sessions, DELTA), ["37", "10", "estimate"]);
    assert.match(run.stdout, /37 chars, ~10 tokens \(estimate\)/);
  });
});

describe("grading a chunk whose coordinator sessions name another chunk folder more often", () => {
  test("warns that the sessions naming it went to another chunk folder, not that none names it", () => {
    const root = mkdtempSync(join(tmpdir(), "coordinator-runs-"));
    const stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));

    try {
      placeFixtures(root);
      stubGh(stubDir);

      const run = grade(root, stubDir, join(root, "out"), "epsilon");
      const warning = run.stderr.split("\n").filter((line) => line.startsWith("epsilon: "));

      assert.equal(run.status, 0, run.stderr);
      assert.equal(warning.length, 1, run.stderr);
      assert.match(
        warning[0],
        /1 coordinator session names .*epsilon, but names another chunk folder more often/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

/** Grades the alpha fixture with a stub gh that gives `answers` for some PRs. */
function gradeWithGh(answers: Readonly<Record<string, GhAnswer>>) {
  const root = mkdtempSync(join(tmpdir(), "coordinator-runs-"));
  const stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));

  try {
    placeFixtures(root);
    stubGh(stubDir, answers);

    return grade(root, stubDir, join(root, "out"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stubDir, { recursive: true, force: true });
  }
}

describe("reading pull requests through gh", () => {
  test("a pull request gh cannot find is a warning, and the run goes on", () => {
    const run = gradeWithGh({ "11": notFound("11") });

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /gh found no pull request acme\/app#11/);
  });

  test("any other gh failure ends the run with exit 2, naming the pull request and the cause", () => {
    const run = gradeWithGh({
      "11": {
        stdout: "",
        stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)",
        status: 1,
      },
    });

    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /acme\/app#11/);
    assert.match(run.stderr, /HTTP 401: Bad credentials/);
  });

  test("an answer gh printed that is no pull request ends the run with exit 2", () => {
    const run = gradeWithGh({
      "11": { stdout: "<html>rate limited</html>", stderr: "", status: 0 },
    });

    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /acme\/app#11/);
  });
});
