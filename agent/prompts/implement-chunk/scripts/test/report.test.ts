import assert from "node:assert/strict";
import { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DEFINED_OUTCOMES,
  LEDGER_HEADER,
  cellsOf,
  chunk,
  promptsDir,
  rowOf,
  scratch,
  scriptsDir,
  sha,
} from "./harness.ts";

test("a PR whose current head has no ledger row is not merge-ready", (t) => {
  const { report } = chunk(t, {
    units: [["u1", "T1", "7"]],
    ledger: [["7", sha("a"), "unit-test-verified", "evidence/u1/test.log"]],
    prs: [{ number: 7, head: sha("b") }],
  });

  const result = report();

  assert.equal(result.status, 1);
  assert.equal(cellsOf(rowOf(result.stdout, "T1"))[6], `no: no verdict at ${sha("b")}`);
});

test("each ticket gets one row with its link, head, verdict, reviewers, and merge state", (t) => {
  const { report } = chunk(t, {
    units: [
      ["u1", "T1", "7"],
      ["u2", "T2", "B"],
      ["u3", "T3", "owner/repo#9"],
      ["u4", "T1", ""],
      ["u5", "T4", "11"],
    ],
    ledger: [
      ["7", sha("a"), "unit-test-verified", "evidence/u1/test.log"],
      ["owner/repo#9", sha("c"), "live-ui-verified", "evidence/u3/ui.png"],
      ["9", sha("d"), "live-deployed-verified", "evidence/u3/live.png"],
      ["11", sha("b"), "unit-test-verified", "evidence/u5/test.log"],
    ],
    prs: [
      {
        number: 7,
        head: sha("a"),
        reviewRequests: [{ login: "alice" }, { slug: "core" }],
      },
      {
        number: 9,
        head: sha("c"),
        state: "MERGED",
        mergeStateStatus: "UNKNOWN",
        mergeCommit: sha("d"),
      },
      { number: 11, head: sha("b"), state: "CLOSED" },
    ],
  });

  const result = report();

  assert.equal(result.status, 1, "T2 has no open final PR");
  assert.deepEqual(cellsOf(rowOf(result.stdout, "T1")), [
    "T1",
    "https://github.com/owner/repo/pull/7",
    sha("a"),
    "unit-test-verified",
    "@alice, @core",
    "open, BLOCKED",
    "yes",
    "-",
  ]);
  assert.deepEqual(cellsOf(rowOf(result.stdout, "T3")), [
    "T3",
    "https://github.com/owner/repo/pull/9",
    sha("c"),
    "live-ui-verified",
    "@alice",
    "merged, UNKNOWN",
    "merged",
    "live-deployed-verified",
  ]);

  const unopened = cellsOf(rowOf(result.stdout, "T2"));

  assert.equal(unopened[1], "B (not opened)");
  assert.equal(unopened[6], "no: not opened");
  assert.equal(cellsOf(rowOf(result.stdout, "T4"))[6], "no: closed without merging");
  assert.equal(result.stdout.split("\n").filter((line) => line.startsWith("| T1 |")).length, 1);
});

function passingRow(n: number, hex: string) {
  return [String(n), sha(hex), "unit-test-verified", "evidence/u/test.log"] as const;
}

test("rows come in merge order: a PR based on another final PR's branch follows it", (t) => {
  const { report } = chunk(t, {
    units: [
      ["u1", "T12", "12"],
      ["u2", "T7", "7"],
      ["u3", "T9", "9"],
    ],
    ledger: [passingRow(12, "c"), passingRow(7, "a"), passingRow(9, "b")],
    prs: [
      { number: 12, head: sha("c"), baseRefName: "chunk/c/7" },
      { number: 7, head: sha("a") },
      { number: 9, head: sha("b") },
    ],
  });

  const result = report();

  const tickets = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("| T") && !line.startsWith("| Ticket"))
    .map((line) => cellsOf(line)[0]);

  assert.deepEqual(tickets, ["T7", "T9", "T12"]);
  assert.equal(result.status, 0);
});

test("a stacked PR follows its parent even when its number is lower", (t) => {
  const result = chunk(t, {
    units: [
      ["u1", "T4", "4"],
      ["u2", "T6", "6"],
      ["u3", "T9", "9"],
    ],
    ledger: [passingRow(4, "c"), passingRow(6, "a"), passingRow(9, "b")],
    prs: [
      { number: 4, head: sha("c"), baseRefName: "chunk/c/6" },
      { number: 6, head: sha("a") },
      { number: 9, head: sha("b") },
    ],
  }).report();

  const order = result.stdout.split("\n").map((line) => cellsOf(line)[0]);

  assert.equal(order.filter((cell) => ["T4", "T6", "T9"].includes(cell ?? "")).length, 3);
  assert.ok(order.indexOf("T6") < order.indexOf("T4"), result.stdout);
  assert.ok(order.indexOf("T6") < order.indexOf("T9"), result.stdout);
});

test("final PRs in different repositories never stack on each other", (t) => {
  const result = chunk(t, {
    units: [
      ["u1", "T5", "other/lib#5"],
      ["u2", "T3", "3"],
    ],
    ledger: [
      passingRow(3, "a"),
      ["other/lib#5", sha("b"), "unit-test-verified", "evidence/u/test.log"],
    ],
    prs: [
      { number: 5, repo: "other/lib", head: sha("b"), headRefName: "chunk/c/shared" },
      { number: 3, head: sha("a"), baseRefName: "chunk/c/shared" },
    ],
  }).report();

  const order = result.stdout.split("\n").map((line) => cellsOf(line)[0]);

  assert.equal(result.status, 0, result.stdout);
  assert.ok(order.indexOf("T3") > -1 && order.indexOf("T3") < order.indexOf("T5"), result.stdout);
});

test("a passing PR with a merge conflict or in draft is not merge-ready", (t) => {
  const result = chunk(t, {
    units: [
      ["u1", "T1", "1"],
      ["u2", "T2", "2"],
    ],
    ledger: [passingRow(1, "a"), passingRow(2, "b")],
    prs: [
      { number: 1, head: sha("a"), mergeStateStatus: "DIRTY" },
      { number: 2, head: sha("b"), mergeStateStatus: "DRAFT" },
    ],
  }).report();

  assert.equal(result.status, 1);
  assert.equal(cellsOf(rowOf(result.stdout, "T1"))[6], "no: merge conflict");
  assert.equal(cellsOf(rowOf(result.stdout, "T2"))[6], "no: draft");
});

test("a ticket that units.tsv maps to two final PRs is not merge-ready", (t) => {
  const result = chunk(t, {
    units: [
      ["u1", "T1", "7"],
      ["u2", "T1", "8"],
    ],
    ledger: [passingRow(7, "a"), passingRow(8, "b")],
    prs: [
      { number: 7, head: sha("a") },
      { number: 8, head: sha("b") },
    ],
  }).report();

  assert.equal(result.status, 1);
  assert.equal(
    cellsOf(rowOf(result.stdout, "T1"))[6],
    "no: units.tsv gives several final PRs: 7, 8",
  );
});

function oneVerdictPerPr(t: TestContext, verdicts: readonly (readonly [string, string])[]) {
  return chunk(t, {
    units: verdicts.map(([outcome], index) => [`u${index}`, outcome, String(index + 1)]),
    ledger: verdicts.map(([outcome, evidence], index) => [
      String(index + 1),
      sha("e"),
      outcome,
      evidence,
    ]),
    prs: verdicts.map((_, index) => ({ number: index + 1, head: sha("e") })),
  }).report();
}

test("blocked and failed verdicts never show as merge-ready", (t) => {
  const failing = ["verifier-blocked", "verifier-failed", "live-failed"];

  const result = oneVerdictPerPr(
    t,
    failing.map((outcome) => [outcome, "evidence/u/run.log"]),
  );

  assert.equal(result.status, 1);

  for (const outcome of failing) {
    const cells = cellsOf(rowOf(result.stdout, outcome));

    assert.equal(cells[3], outcome);
    assert.equal(cells[6], `no: ${outcome}`);
  }
});

test("passing verdicts show as merge-ready", (t) => {
  const passing = ["live-deployed-verified", "live-ui-verified", "unit-test-verified"];

  const result = oneVerdictPerPr(
    t,
    passing.map((outcome) => [outcome, "ran the suite"]),
  );

  assert.equal(result.status, 0);

  for (const outcome of passing) assert.equal(cellsOf(rowOf(result.stdout, outcome))[6], "yes");
});

test("conditional verdicts pass only with a citation, and type-check-only needs sign-off", (t) => {
  const conditional = [
    "not-applicable",
    "fails-identically-at-base",
    "accepted-gap",
    "isolated-pass-flake",
  ];

  const cited = oneVerdictPerPr(
    t,
    conditional.map((outcome, index) => [
      outcome,
      index % 2 === 0
        ? "decisions.md#4"
        : "base and head: evidence/u2/base.log evidence/u2/head.log",
    ]),
  );

  assert.equal(cited.status, 0);

  for (const outcome of conditional) assert.equal(cellsOf(rowOf(cited.stdout, outcome))[6], "yes");

  const uncited = oneVerdictPerPr(t, [
    ...conditional.map((outcome): [string, string] => [outcome, "lock-only diff"]),
    ["type-check-only", "decisions.md#5"],
  ]);

  assert.equal(uncited.status, 1);

  for (const outcome of conditional) {
    assert.match(cellsOf(rowOf(uncited.stdout, outcome))[6] ?? "", /^no: /);
  }

  assert.equal(cellsOf(rowOf(uncited.stdout, "type-check-only"))[6], "no: needs lead sign-off");
});

test("a ledger label outside the vocabulary is rejected with its line number", (t) => {
  const { report } = chunk(t, {
    units: [["u1", "T1", "7"]],
    ledger: [
      ["7", sha("a"), "unit-test-verified", "evidence/u/test.log"],
      ["3", sha("f"), "ci-green", "CI passed"],
    ],
    prs: [{ number: 7, head: sha("a") }],
  });

  const result = report();

  assert.equal(cellsOf(rowOf(result.stdout, "T1"))[6], "yes");
  assert.equal(result.status, 1, "the intermediate PR's label fails the run");
  assert.match(result.stdout, /ledger\.tsv:3: "ci-green" is not a Ledger outcome/);
});

test("a row with each defined verdict passes the vocabulary check", (t) => {
  const { report } = chunk(t, {
    units: [["u1", "T1", "1"]],
    ledger: DEFINED_OUTCOMES.map((outcome, index) => [
      String(index + 1),
      sha("a"),
      outcome,
      "decisions.md#1",
    ]),
    prs: [{ number: 1, head: sha("a") }],
  });

  assert.match(report().stdout, /ledger violations: 0$/m);
});

interface PromptCopy {
  readonly brief: string;
  readonly entry: string;
}

/** A copy of the prompt folder layout, so a test can edit the brief the CLI reads. */
function promptCopy(t: TestContext): PromptCopy {
  const root = scratch(t);
  const folder = join(root, "implement-chunk");
  const effect = createRequire(import.meta.url).resolve("effect");

  const nodeModules = effect.slice(
    0,
    effect.lastIndexOf("/node_modules/") + "/node_modules".length,
  );

  cpSync(scriptsDir, join(folder, "scripts"), { recursive: true });
  cpSync(join(promptsDir, "implement-chunk", "brief.md"), join(folder, "brief.md"));
  symlinkSync(nodeModules, join(root, "node_modules"));

  return { brief: join(folder, "brief.md"), entry: join(folder, "scripts", "chunk.ts") };
}

test("the vocabulary lives only in brief.md's Ledger outcomes table", (t) => {
  const copy = promptCopy(t);
  const original = readFileSync(copy.brief, "utf8");
  const failedRow = original.split("\n").find((line) => line.startsWith("| `live-failed`"));

  assert.ok(failedRow !== undefined);
  writeFileSync(
    copy.brief,
    original.replace(failedRow, `${failedRow}\n| \`ci-green\` | yes | CI passed. |`),
  );

  const fixture = chunk(t, {
    units: [["u1", "T1", "7"]],
    ledger: [["7", sha("a"), "ci-green", "CI passed"]],
    prs: [{ number: 7, head: sha("a") }],
  });

  const accepted = fixture.report(copy.entry);

  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(accepted.stdout, /ledger violations: 0$/m);

  writeFileSync(copy.brief, original);

  const removed = fixture.report(copy.entry);

  assert.equal(removed.status, 1);
  assert.match(removed.stdout, /ledger\.tsv:2: "ci-green" is not a Ledger outcome/);
});

test("the report refuses a ledger whose header differs and prints the expected one", (t) => {
  const fixture = chunk(t, { units: [["u1", "T1", "7"]], prs: [{ number: 7, head: sha("a") }] });

  writeFileSync(join(fixture.state, "ledger.tsv"), "pr\thead_sha\tverdict\tby\tevidence\n");

  const result = fixture.report();

  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(LEDGER_HEADER), result.stderr);
});

test("a gh failure makes the report exit 2, never a clean or violation code", (t) => {
  const result = chunk(t, { units: [["u1", "T1", "404"]] }).report();

  assert.equal(result.status, 2);
  assert.match(cellsOf(rowOf(result.stdout, "T1"))[6] ?? "", /^unknown: .*no pull requests found/);
});
