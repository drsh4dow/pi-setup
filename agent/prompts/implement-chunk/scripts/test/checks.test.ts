import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  type StructuralProblem,
  reportOnlyMergeProblems,
  unterminatedSubagentProblems,
} from "../checks.ts";
import { type PrRef, parsePrRef } from "../pull-request.ts";
import { parseLedger, parseSpawns, parseUnits } from "../state.ts";
import {
  LEDGER_HEADER,
  SPAWNS_HEADER,
  UNITS_HEADER,
  cellsOf,
  chunk,
  rowOf,
  run,
  scratch,
  sha,
} from "./harness.ts";

const fixtures = fileURLToPath(new URL("fixtures/", import.meta.url));

function fixture(path: string) {
  const file = join(fixtures, path);

  return { file, text: readFileSync(file, "utf8") };
}

function prRef(text: string): PrRef {
  const ref = parsePrRef(text);

  assert.ok(ref !== null, `not a PR reference: ${text}`);

  return ref;
}

function messages(problems: readonly StructuralProblem[]): string[] {
  return problems.map(({ message }) => message);
}

function units(rows: readonly (readonly [string, string])[]) {
  const text = [
    UNITS_HEADER,
    ...rows.map(([id, state]) => [id, "T1", "", "-", state, "", "", "", ""].join("\t")),
  ].join("\n");

  return parseUnits("units.tsv", `${text}\n`);
}

function spawns(rows: readonly (readonly [string, string, string, string])[]) {
  const text = [
    SPAWNS_HEADER,
    ...rows.map(([session, role, unit, state]) =>
      [session, "root", "delegate", role, "1", unit, session, state, "2026-10-28T00:00:00Z"].join(
        "\t",
      ),
    ),
  ].join("\n");

  return parseSpawns("spawns.tsv", `${text}\n`);
}

function ledger(rows: readonly (readonly [string, string, string, string])[]) {
  const text = [
    LEDGER_HEADER,
    ...rows.map((row) => [...row, "2026-10-28T00:00:00Z"].join("\t")),
  ].join("\n");

  return parseLedger("ledger.tsv", `${text}\n`);
}

test("unterminated-subagent: each unit row a past chunk left unended is a problem", () => {
  const { file, text } = fixture("unterminated-subagent/units.tsv");
  const problems = messages(unterminatedSubagentProblems(file, parseUnits(file, text)));

  const recorded = [
    ["final-E/PE-6394", "pr-open"],
    ["final-E/PE-6395", "pr-open"],
    ["F-A6", "running"],
    ["F-E6", "pr-open"],
    ["hasura-C", "running"],
    ["walk-C", "planned"],
    ["watch-DAB-5", "running"],
  ];

  assert.equal(problems.length, recorded.length, problems.join("\n"));

  recorded.forEach(([id = "", state = ""], index) => {
    const problem = problems[index] ?? "";

    assert.ok(problem.startsWith(`${file}:${index + 2}: unit ${id} `), problem);
    assert.ok(problem.includes(state), problem);
  });
});

test("unterminated-subagent: an ended unit passes, in the free-text forms past chunks wrote too", () => {
  const ended = units([
    ["a", "merged"],
    ["b", "done"],
    ["c", "abandoned"],
    ["d", "reconciled"],
    ["e", "done: 0 act-on"],
    ["f", "abandoned-canceled(repo archived)"],
  ]);

  assert.deepEqual(unterminatedSubagentProblems("units.tsv", ended), []);

  const open = units([
    ["g", "running bt-1"],
    ["h", ""],
    ["i", "verified"],
  ]);

  assert.deepEqual(
    messages(unterminatedSubagentProblems("units.tsv", open)).map(
      (problem) => problem.split(" ")[2],
    ),
    ["g", "h", "i"],
  );
});

test("report-only-merge: each merged final PR whose verdict no verifier reported is a problem", () => {
  const { file, text } = fixture("report-only-merge/ledger.tsv");

  const heads = fixture("report-only-merge/final-prs.tsv")
    .text.trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"));

  const finalPrs = heads.map(([pr = "", head = ""]) => ({ ref: prRef(pr), head }));

  const problems = messages(
    reportOnlyMergeProblems({
      ledgerFile: file,
      ledger: parseLedger(file, text),
      spawns: [],
      finalPrs,
    }),
  );

  assert.equal(problems.length, heads.length, problems.join("\n"));

  heads.forEach(([pr = "", head = ""], index) => {
    const problem = problems[index] ?? "";

    assert.ok(problem.includes(` ${pr} `) && problem.includes(head), problem);
  });

  assert.match(problems[5] ?? "", /no verdict at its head/);
});

test("report-only-merge: a verdict passes only on evidence of a verifier that reported", () => {
  const pr = "owner/repo#7";
  const head = sha("a");
  const finalPrs = [{ ref: prRef(pr), head }];

  const check = (
    rows: readonly (readonly [string, string, string, string])[],
    registry: readonly (readonly [string, string, string, string])[],
  ) =>
    reportOnlyMergeProblems({
      ledgerFile: "ledger.tsv",
      ledger: ledger(rows),
      spawns: spawns(registry),
      finalPrs,
    }).length;

  const verified = [pr, head, "unit-test-verified", "evidence/V7/REPORT.md"] as const;
  const reported = ["s1", "verifier", "V7", "reported"] as const;

  assert.equal(check([verified], [reported]), 0, "a verifier's report at the head");
  assert.equal(
    check([verified], [["s1", "live-verifier", "V7", "reported"]]),
    0,
    "a live verifier's report",
  );
  assert.equal(
    check(
      [
        [pr, sha("b"), "unit-test-verified", "see evidence/V7/REPORT.md"],
        [pr, head, "unit-test-verified", `carried from ${sha("b")}`],
      ],
      [reported],
    ),
    0,
    "a verdict carried from a verifier's report",
  );

  assert.equal(check([verified], []), 1, "no spawn registered for the cited unit");
  assert.equal(
    check([verified], [["s1", "verifier", "V7", "running"]]),
    1,
    "the verifier has not reported",
  );
  assert.equal(
    check([verified], [reported, ["s1", "verifier", "V7", "failed"]]),
    1,
    "the verifier's last row says it failed",
  );
  assert.equal(
    check(
      [[pr, head, "unit-test-verified", "evidence/F/lead-verdict.md"]],
      [["s2", "implementer", "F", "reported"]],
    ),
    1,
    "the cited unit is an implementer",
  );
  assert.equal(
    check([[pr, sha("b"), "unit-test-verified", "evidence/V7/REPORT.md"]], [reported]),
    1,
    "the verifier's report is at another head",
  );
});

test("report-only-merge: a chain unit's verifier passes on its whole id, and only on it", () => {
  const pr = "owner/repo#7";
  const head = sha("a");

  const check = (evidence: string, unit: string) =>
    reportOnlyMergeProblems({
      ledgerFile: "ledger.tsv",
      ledger: ledger([[pr, head, "unit-test-verified", evidence]]),
      spawns: spawns([["s1", "verifier", unit, "reported"]]),
      finalPrs: [{ ref: prRef(pr), head }],
    }).length;

  assert.equal(check("evidence/chain/T1/REPORT.md", "chain/T1"), 0, "a chain id holds a slash");
  assert.equal(check("see /state/evidence/V7/REPORT.md", "V7"), 0, "an absolute citation");
  assert.equal(check("evidence/chain/T2/REPORT.md", "chain/T1"), 1, "another ticket of the chain");
  assert.equal(check("evidence/V7x/REPORT.md", "V7"), 1, "a unit whose id starts the same");
  assert.equal(check("evidence/chain/V7/REPORT.md", "V7"), 1, "a unit of that name in a chain");
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

test("ledger carry and chunk report stand a carried verdict on the same source row", (t) => {
  const repo = join(scratch(t), "repo");

  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "verified");

  const from = git(repo, "rev-parse", "HEAD");

  git(repo, "commit", "-q", "--allow-empty", "-m", "same tree");

  const head = git(repo, "rev-parse", "HEAD");

  // Both rows sit at the SHA carried from: PR 7's, written bare, then another PR's.
  const folder = chunk(t, {
    units: [["V7", "T1", "owner/repo#7", "done"]],
    ledger: [
      ["7", from, "unit-test-verified", "evidence/V7/REPORT.md", "medium", "verified"],
      ["owner/repo#8", from, "unit-test-verified", "evidence/LEAD/report.md", "low", "lead only"],
    ],
    prs: [{ number: 7, head }],
  });

  writeFileSync(join(folder.state, "mode"), "sh4dow\n");
  writeFileSync(
    join(folder.state, "spawns.tsv"),
    `${SPAWNS_HEADER}\ns1\troot\tdelegate\tverifier\t1\tV7\tverify\treported\t2026-10-28T00:00:00Z\n`,
  );

  const carried = run([
    "--state",
    folder.state,
    "ledger",
    "carry",
    "owner/repo#7",
    head,
    from,
    "-C",
    repo,
  ]);

  assert.equal(carried.status, 0, carried.stderr);

  const rows = readFileSync(join(folder.state, "ledger.tsv"), "utf8").trimEnd().split("\n");

  assert.deepEqual(
    rows.at(-1)?.split("\t").slice(4, 6),
    ["medium", "verified"],
    "PR 7's risk call",
  );

  const report = folder.report();

  assert.equal(report.status, 0, report.stdout + report.stderr);
});

test("chunk report holds a sh4dow chunk back on a past report-only merge, and passes a verified one", (t) => {
  const pr = "drsh4dow/pi-setup#128";
  const head = "357f1870a4eb5b282a205252c9843293aa7eac6b";
  const merged = { number: 128, repo: "drsh4dow/pi-setup", head, state: "MERGED" } as const;

  const past = chunk(t, {
    units: [["F", "126", pr]],
    ledger: [[pr, head, "live-ui-verified", "evidence/F/lead-verdict.md"]],
    prs: [merged],
  });

  writeFileSync(join(past.state, "mode"), "sh4dow\n");

  const refused = past.report();

  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /report-only-merge: final PR drsh4dow\/pi-setup#128 at 357f187/);

  const verified = chunk(t, {
    units: [["F", "126", pr]],
    ledger: [[pr, head, "live-ui-verified", "evidence/V-F/REPORT.md"]],
    prs: [merged],
  });

  writeFileSync(join(verified.state, "mode"), "sh4dow\n");
  writeFileSync(
    join(verified.state, "spawns.tsv"),
    `${SPAWNS_HEADER}\ns1\troot\tdelegate\tverifier\t1\tV-F\tverify-F\treported\t2026-10-28T00:00:00Z\n`,
  );

  const passed = verified.report();

  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.doesNotMatch(passed.stdout, /report-only-merge/);
});

test("a final PR a structural check holds back is not merge-ready in the table or the summary", (t) => {
  const head = sha("a");

  const folder = chunk(t, {
    units: [
      ["F", "T1", "7", "done"],
      ["G", "T2", "8", "done"],
    ],
    ledger: [
      ["7", head, "unit-test-verified", "evidence/F/implementer.md", "high", "protocol"],
      ["8", head, "unit-test-verified", "evidence/V8/REPORT.md", "low", "docs"],
    ],
    prs: [
      { number: 7, head },
      { number: 8, head },
    ],
  });

  writeFileSync(join(folder.state, "mode"), "sh4dow\n");
  writeFileSync(
    join(folder.state, "spawns.tsv"),
    `${SPAWNS_HEADER}\ns1\troot\tdelegate\tverifier\t1\tV8\tverify\treported\t2026-10-28T00:00:00Z\n`,
  );

  const result = folder.report();

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(cellsOf(rowOf(result.stdout, "T1"))[6] ?? "", /^no: /);
  assert.equal(cellsOf(rowOf(result.stdout, "T2"))[6], "yes");
  assert.match(
    result.stdout,
    /^merge-ready or merged: 1 of 2 tickets; .*the chunk is not merge-ready$/m,
  );
});

test("any structural problem makes the summary say the chunk is not merge-ready", (t) => {
  const pr = "drsh4dow/pi-setup#128";
  const head = sha("c");

  const result = chunk(t, {
    units: [
      ["F", "126", pr],
      ["F-A6", "-", "-", "running"],
    ],
    ledger: [[pr, head, "unit-test-verified", "evidence/V-F/REPORT.md"]],
    prs: [{ number: 128, repo: "drsh4dow/pi-setup", head, state: "MERGED" }],
  }).report();

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(cellsOf(rowOf(result.stdout, "126"))[6], "merged");
  assert.match(
    result.stdout,
    /^merge-ready or merged: 1 of 1 tickets; .*the chunk is not merge-ready$/m,
  );
});

test("an implement-chunk chunk, which keeps no spawn registry, is not judged for report-only merges", (t) => {
  const pr = "drsh4dow/pi-setup#128";
  const head = "357f1870a4eb5b282a205252c9843293aa7eac6b";

  const result = chunk(t, {
    units: [["F", "126", pr]],
    ledger: [[pr, head, "live-ui-verified", "evidence/F/lead-verdict.md"]],
    prs: [{ number: 128, repo: "drsh4dow/pi-setup", head, state: "MERGED" }],
  }).report();

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("chunk report refuses a state folder whose mode is neither absent nor sh4dow", (t) => {
  const pr = "drsh4dow/pi-setup#128";
  const head = sha("c");

  const folder = chunk(t, {
    units: [["F", "126", pr]],
    ledger: [[pr, head, "unit-test-verified", "evidence/F/lead-verdict.md"]],
    prs: [{ number: 128, repo: "drsh4dow/pi-setup", head, state: "MERGED" }],
  });

  writeFileSync(join(folder.state, "mode"), "shadow\n");

  const result = folder.report();

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown mode "shadow"/);
});

test("chunk report holds a chunk back while a past unit is still running", (t) => {
  const pr = "drsh4dow/pi-setup#128";
  const head = sha("c");

  const result = chunk(t, {
    units: [
      ["F", "126", pr],
      ["F-A6", "-", "-", "running"],
    ],
    ledger: [[pr, head, "unit-test-verified", "evidence/V-F/REPORT.md"]],
    prs: [{ number: 128, repo: "drsh4dow/pi-setup", head, state: "MERGED" }],
  }).report();

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /units\.tsv:3: unit F-A6 is running/);
});
