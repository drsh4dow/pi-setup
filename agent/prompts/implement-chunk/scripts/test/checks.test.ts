import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { reportOnlyMergeProblems, unterminatedSubagentProblems } from "../checks.ts";
import { type PrRef, parsePrRef } from "../pull-request.ts";
import { parseLedger, parseSpawns, parseUnits } from "../state.ts";
import { SPAWNS_HEADER, UNITS_HEADER, chunk, sha } from "./harness.ts";

// The rows past chunks left, copied from the lines the coordinator-runs baseline named; see
// fixtures/README.md for each row's source, session, and entry.
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
    "pr\thead_sha\toutcome\tevidence\trecorded_at",
    ...rows.map((row) => [...row, "2026-10-28T00:00:00Z"].join("\t")),
  ].join("\n");

  return parseLedger("ledger.tsv", `${text}\n`);
}

test("unterminated-subagent: each unit row a past chunk left unended is a problem", () => {
  const { file, text } = fixture("unterminated-subagent/units.tsv");
  const problems = unterminatedSubagentProblems(file, parseUnits(file, text));

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
    unterminatedSubagentProblems("units.tsv", open).map((problem) => problem.split(" ")[2]),
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

  const problems = reportOnlyMergeProblems({
    ledgerFile: file,
    ledger: parseLedger(file, text),
    spawns: [],
    finalPrs,
  });

  assert.equal(problems.length, heads.length, problems.join("\n"));

  heads.forEach(([pr = "", head = ""], index) => {
    const problem = problems[index] ?? "";

    assert.ok(problem.includes(` ${pr} `) && problem.includes(head), problem);
  });

  // monorepo#5961 merged at a head no ledger row names.
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

test("an implement-chunk chunk, which keeps no spawn registry, is not judged for report-only merges", (t) => {
  const pr = "drsh4dow/pi-setup#128";
  const head = "357f1870a4eb5b282a205252c9843293aa7eac6b";

  const run = chunk(t, {
    units: [["F", "126", pr]],
    ledger: [[pr, head, "live-ui-verified", "evidence/F/lead-verdict.md"]],
    prs: [{ number: 128, repo: "drsh4dow/pi-setup", head, state: "MERGED" }],
  }).report();

  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("chunk report holds a chunk back while a past unit is still running", (t) => {
  const pr = "drsh4dow/pi-setup#128";
  const head = sha("c");

  const run = chunk(t, {
    units: [
      ["F", "126", pr],
      ["F-A6", "-", "-", "running"],
    ],
    ledger: [[pr, head, "unit-test-verified", "evidence/V-F/REPORT.md"]],
    prs: [{ number: 128, repo: "drsh4dow/pi-setup", head, state: "MERGED" }],
  }).report();

  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /units\.tsv:3: unit F-A6 is running/);
});
