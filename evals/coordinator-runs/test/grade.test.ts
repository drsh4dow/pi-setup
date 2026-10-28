// Runs the grader's CLI on the synthetic chunk under fixtures/, with a stub `gh` on a PATH that
// cannot reach the real one, and checks each count it writes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const GRADE = join(here, "..", "grade.ts");

const FIXTURES = join(here, "..", "fixtures");

const id = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;

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

// What GitHub reports for each PR of the fixture chunk: number -> [state, head at merge, head branch].
const PULL_REQUESTS = {
  "7": ["MERGED", "b".repeat(40), "u/impl-a"],
  "8": ["MERGED", "d".repeat(40), "u/impl-b"],
  "9": ["MERGED", "e".repeat(40), "chunk/alpha/app"],
  "10": ["MERGED", "f".repeat(40), "chunk/alpha/second"],
  "11": ["OPEN", "1".repeat(40), "u/impl-c"],
  "12": ["MERGED", "4444444".padEnd(40, "0"), "u/impl-d"],
} satisfies Record<string, readonly [string, string, string]>;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type Rows = readonly Readonly<Record<string, string>>[];

function readTsv(path: string): Rows {
  const [header, ...rows] = readFileSync(path, "utf8").trimEnd().split("\n");
  const columns = header.split("\t");

  return rows.map((row) => {
    const cells = row.split("\t");

    return Object.fromEntries(columns.map((column, index) => [column, cells[index] ?? ""]));
  });
}

/** Copies the fixtures into `root`, writing `root` wherever a fixture says `{{ROOT}}`. */
function placeFixtures(root: string) {
  cpSync(FIXTURES, root, { recursive: true });

  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const path = join(entry.parentPath, entry.name);

    writeFileSync(path, readFileSync(path, "utf8").replaceAll("{{ROOT}}", root));
  }
}

function stubGh(dir: string) {
  const path = join(dir, "gh");

  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      `const prs = ${JSON.stringify(PULL_REQUESTS)};`,
      `const args = process.argv.slice(2);`,
      `const repo = args[args.indexOf("--repo") + 1];`,
      `const pr = prs[args[args.indexOf("view") + 1]];`,
      `if (repo !== "acme/app" || !pr) { console.error("no pull request found"); process.exit(1); }`,
      `console.log(JSON.stringify({ state: pr[0], headRefOid: pr[1], headRefName: pr[2] }));`,
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function grade(root: string, pathDir: string, out: string, chunk = "alpha"): Run {
  const result = spawnSync(
    process.execPath,
    [
      GRADE,
      "--sessions",
      join(root, "session-files"),
      "--state",
      join(root, `state/demo/implement-chunk/${chunk}`),
      "--out",
      out,
    ],
    { encoding: "utf8", env: { PATH: pathDir, HOME: join(root, "home") }, timeout: 60_000 },
  );

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

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
    assert.deepEqual(found("root-edit"), [`${COORDINATOR} c0000006 ${root}/work/src/app.ts`]);
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
  let findings: Rows = [];

  before(() => {
    root = mkdtempSync(join(tmpdir(), "coordinator-runs-"));
    stubDir = mkdtempSync(join(tmpdir(), "coordinator-runs-gh-"));
    placeFixtures(root);
    stubGh(stubDir);

    const run = grade(root, stubDir, join(root, "out"), "gamma");

    assert.equal(run.status, 0, run.stderr);
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
      ],
    );
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
      [`${DELTA} - r1 running bt-1 ${root}/state/demo/implement-chunk/delta/units.tsv:4`],
    );
  });

  test("rounds the skill table's token estimate up", () => {
    // 37 characters: `<available_skills></available_skills>`.
    assert.deepEqual(skillTable(sessions, DELTA), ["37", "10", "estimate"]);
    assert.match(run.stdout, /37 chars, ~10 tokens \(estimate\)/);
  });
});
