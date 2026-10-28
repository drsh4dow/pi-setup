import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  LEDGER_HEADER,
  RISK_LEDGER_HEADER,
  type Run,
  UNITS_HEADER,
  cli,
  promptsDir,
  run,
  scratch,
  sha,
} from "./harness.ts";

const COORDINATOR_PROMPTS = {
  "implement-chunk.md": join(promptsDir, "implement-chunk.md"),
  "system/sh4dow.md": join(promptsDir, "..", "system", "sh4dow.md"),
};

for (const [name, path] of Object.entries(COORDINATOR_PROMPTS)) {
  const ledgerHeader = name === "system/sh4dow.md" ? RISK_LEDGER_HEADER : LEDGER_HEADER;

  test(`${name} names the columns the CLI writes`, () => {
    const prompt = readFileSync(path, "utf8");

    const columns = (file: string) =>
      prompt
        .match(new RegExp(`\`${file}\` columns: \`([^\`]+)\``))?.[1]
        ?.split(" ")
        .join("\t");

    assert.equal(columns("units.tsv"), UNITS_HEADER);
    assert.equal(columns("ledger.tsv"), ledgerHeader);
  });

  test(`${name} names the unit states the CLI accepts`, () => {
    const prompt = readFileSync(path, "utf8");

    assert.equal(
      prompt.match(/`units.tsv` states: `([^`]+)`/)?.[1],
      "planned running pr-open merged done abandoned reconciled",
    );
  });
}

test("ledger record appends a row and refuses an outcome outside the vocabulary", (t) => {
  const state = scratch(t);
  const ledger = join(state, "ledger.tsv");

  const recorded = run([
    "--state",
    state,
    "ledger",
    "record",
    "#7",
    sha("a"),
    "unit-test-verified",
    "evidence/u1/test.log",
  ]);

  assert.equal(recorded.status, 0, recorded.stderr);

  const [header, row, ...rest] = readFileSync(ledger, "utf8").split("\n");

  assert.equal(header, LEDGER_HEADER);
  assert.deepEqual(row?.split("\t").slice(0, 4), [
    "7",
    sha("a"),
    "unit-test-verified",
    "evidence/u1/test.log",
  ]);
  assert.deepEqual(rest, [""]);

  const refused = run([
    "--state",
    state,
    "ledger",
    "record",
    "7",
    sha("b"),
    "ci-green",
    "CI passed",
  ]);

  assert.equal(refused.status, 2);
  assert.ok(refused.stderr.includes(`7\t${sha("b")}\tci-green\tCI passed`), refused.stderr);
  assert.equal(
    run(["--state", state, "ledger", "record", "7", "abc123", "unit-test-verified", "x"]).status,
    2,
  );
  assert.equal(readFileSync(ledger, "utf8").split("\n").length, 3, "refusals write nothing");
});

function record(state: string, pr: string, hex: string, ...flags: string[]) {
  return run([
    "--state",
    state,
    "ledger",
    "record",
    pr,
    sha(hex),
    "unit-test-verified",
    `evidence/u${pr}/test.log`,
    ...flags,
  ]);
}

function ledgerLines(state: string): string[] {
  return readFileSync(join(state, "ledger.tsv"), "utf8").split("\n");
}

function riskCalls(state: string): string[][] {
  return ledgerLines(state)
    .slice(1, -1)
    .map((line) => line.split("\t").slice(4, 6));
}

function sh4dow(state: string): void {
  writeFileSync(join(state, "mode"), "sh4dow\n");
}

test("ledger record keeps the verifier's risk call with its verdict", (t) => {
  const state = scratch(t);

  sh4dow(state);

  const recorded = record(
    state,
    "7",
    "a",
    "--risk",
    "high",
    "--risk-reason",
    "rewrites the parser",
  );

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(ledgerLines(state)[0], RISK_LEDGER_HEADER);
  assert.deepEqual(ledgerLines(state)[1]?.split("\t").slice(0, 6), [
    "7",
    sha("a"),
    "unit-test-verified",
    "evidence/u7/test.log",
    "high",
    "rewrites the parser",
  ]);
});

test("a new ledger takes the risk columns only in a sh4dow state folder", (t) => {
  const plain = scratch(t);
  const recorded = record(plain, "7", "a");

  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(ledgerLines(plain)[0], LEDGER_HEADER);
  assert.deepEqual(ledgerLines(plain)[1]?.split("\t").slice(0, 4), [
    "7",
    sha("a"),
    "unit-test-verified",
    "evidence/u7/test.log",
  ]);
  assert.equal(ledgerLines(plain)[1]?.split("\t").length, 5);

  const marked = scratch(t);

  sh4dow(marked);
  assert.equal(record(marked, "7", "a", "--risk", "low", "--risk-reason", "docs").status, 0);
  assert.equal(ledgerLines(marked)[0], RISK_LEDGER_HEADER);
  assert.deepEqual(riskCalls(marked), [["low", "docs"]]);
});

test("a sh4dow run refuses a verdict without a risk call", (t) => {
  const state = scratch(t);

  sh4dow(state);

  const refused = record(state, "7", "a");

  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--risk <low\|medium\|high> --risk-reason <text>/);
  assert.equal(existsSync(join(state, "ledger.tsv")), false, "a refusal writes nothing");

  const accepted = record(state, "7", "a", "--risk", "low", "--risk-reason", "docs only");

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(riskCalls(state), [["low", "docs only"]]);
});

test("the risk call sh4dow.md documents is the one chunk enforces", (t) => {
  const prompt = readFileSync(COORDINATOR_PROMPTS["system/sh4dow.md"], "utf8");
  const [, mode = "", file = ""] = prompt.match(/write `([^`]+)` to its `([^`]+)` file/) ?? [];
  const syntax = prompt.match(/`chunk ledger record <pr> <sha> <outcome> <evidence> ([^`]+)`/)?.[1];
  const state = scratch(t);

  assert.ok(syntax !== undefined && file !== "", "sh4dow.md names the mode file and the flags");
  writeFileSync(join(state, file), `${mode}\n`);
  assert.equal(record(state, "7", "a").status, 2, "refused without a risk call");

  const flags = syntax.replace("<low|medium|high>", "high").replace("<text>", "new-parser");
  const accepted = record(state, "7", "a", ...flags.split(" "));

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(riskCalls(state), [["high", "new-parser"]]);
});

test("a risk call needs a level from the closed set and a one-line reason", (t) => {
  const state = scratch(t);

  sh4dow(state);
  assert.equal(record(state, "7", "a", "--risk", "low", "--risk-reason", "docs").status, 0);

  for (const flags of [
    ["--risk", "severe", "--risk-reason", "x"],
    ["--risk", "high"],
    ["--risk-reason", "x"],
    ["--risk", "high", "--risk-reason", ""],
    ["--risk", "high", "--risk-reason", "two\nlines"],
  ]) {
    assert.equal(record(state, "8", "b", ...flags).status, 2, flags.join(" "));
  }

  assert.equal(
    run(["--state", state, "unit", "add", "u1", "ticket=T1", "--risk", "high"]).status,
    2,
    "a risk call outside ledger record",
  );
  assert.equal(ledgerLines(state).length, 3, "refusals write nothing");
});

test("a state folder whose mode is neither absent nor sh4dow is refused", (t) => {
  const state = scratch(t);

  writeFileSync(join(state, "mode"), "shadow\n");

  const refused = record(state, "7", "a");

  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /unknown mode "shadow"/);
  assert.equal(existsSync(join(state, "ledger.tsv")), false, "a refusal creates no ledger");
});

function fiveColumnLedger(state: string, rows = 1): string {
  const text =
    `${LEDGER_HEADER}\n` +
    `1\t${sha("a")}\tunit-test-verified\tevidence/u1/test.log\t2026-10-23T19:57:00Z\n`.repeat(rows);

  writeFileSync(join(state, "ledger.tsv"), text);

  return text;
}

test("a verdict recorded on a five-column ledger leaves every byte before it alone", (t) => {
  const state = scratch(t);
  const before = fiveColumnLedger(state);
  const recorded = record(state, "8", "b");

  assert.equal(recorded.status, 0, recorded.stderr);

  const after = readFileSync(join(state, "ledger.tsv"), "utf8");

  assert.ok(after.startsWith(before), after);
  assert.match(
    after.slice(before.length),
    new RegExp(`^8\\t${sha("b")}\\tunit-test-verified\\tevidence/u8/test.log\\t[^\\t]+\\n$`),
  );
});

test("a risk call on a five-column ledger is refused and names the mode file", (t) => {
  const state = scratch(t);
  const before = fiveColumnLedger(state);
  const refused = record(state, "8", "b", "--risk", "low", "--risk-reason", "docs only");

  assert.equal(refused.status, 2);
  assert.ok(refused.stderr.includes(join(state, "mode")), refused.stderr);
  assert.equal(readFileSync(join(state, "ledger.tsv"), "utf8"), before, "a refusal writes nothing");

  const fresh = scratch(t);

  assert.equal(record(fresh, "8", "b", "--risk", "low", "--risk-reason", "docs only").status, 2);
  assert.equal(existsSync(join(fresh, "ledger.tsv")), false, "nor creates a ledger");
});

for (const mode of ["absent", "sh4dow"] as const) {
  test(`with mode ${mode}, a refused first verdict leaves the state folder as it was`, (t) => {
    const before = mode === "sh4dow" ? ["mode"] : [];

    function fresh(): string {
      const state = scratch(t);

      if (mode === "sh4dow") sh4dow(state);

      return state;
    }

    for (const [evidence, reason] of [
      ["evidence/one\nevidence/two", "docs"],
      ["evidence/one\tevidence/two", "docs"],
      ...(mode === "sh4dow"
        ? [
            ["evidence/u7", "two\nlines"],
            ["evidence/u7", "a\ttab"],
          ]
        : []),
    ] as const) {
      const state = fresh();

      const refused = run([
        "--state",
        state,
        "ledger",
        "record",
        "7",
        sha("a"),
        "unit-test-verified",
        evidence,
        ...(mode === "sh4dow" ? ["--risk", "low", "--risk-reason", reason] : []),
      ]);

      assert.equal(refused.status, 2, JSON.stringify([evidence, reason]));
      assert.deepEqual(readdirSync(state), before, JSON.stringify([evidence, reason]));
    }

    const state = fresh();
    const carry = run(["--state", state, "ledger", "carry", "7", sha("b"), sha("a"), "-C", state]);

    assert.equal(carry.status, 2, carry.stderr);
    assert.deepEqual(readdirSync(state), before, "a refused first carry");
  });
}

function recordAtOnce(state: string, pr: string, hex: string, ...flags: string[]): Promise<Run> {
  const child = spawn(cli, [
    "--state",
    state,
    "ledger",
    "record",
    pr,
    sha(hex),
    "unit-test-verified",
    `evidence/u${pr}/test.log`,
    ...flags,
  ]);

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve) =>
    child.on("close", (status) => resolve({ status, stdout, stderr })),
  );
}

test("two verdicts recorded at once on a five-column ledger both stand", async (t) => {
  const state = scratch(t);

  // A long ledger widens the window in which a writer that rewrites the file races the other.
  fiveColumnLedger(state, 20_000);

  const results = await Promise.all([recordAtOnce(state, "2", "b"), recordAtOnce(state, "3", "c")]);

  for (const result of results) assert.equal(result.status, 0, result.stderr);

  const added = ledgerLines(state)
    .slice(1, -1)
    .map((line) => line.split("\t")[0] ?? "")
    .filter((pr) => pr !== "1");

  assert.deepEqual(
    added.toSorted((a, b) => a.localeCompare(b)),
    ["2", "3"],
  );
});

for (const mode of ["absent", "sh4dow"] as const) {
  test(`with mode ${mode}, first verdicts recorded at once into no ledger all stand under one header`, async (t) => {
    const state = scratch(t);
    const prs = Array.from({ length: 12 }, (_, index) => String(index + 1));
    const flags = mode === "sh4dow" ? ["--risk", "low", "--risk-reason", "docs"] : [];

    if (mode === "sh4dow") sh4dow(state);

    const results = await Promise.all(prs.map((pr) => recordAtOnce(state, pr, "a", ...flags)));

    for (const result of results) assert.equal(result.status, 0, result.stderr);

    const [header, ...rows] = ledgerLines(state).slice(0, -1);

    assert.equal(header, mode === "sh4dow" ? RISK_LEDGER_HEADER : LEDGER_HEADER);
    assert.deepEqual(
      rows.map((line) => line.split("\t")[0] ?? "").toSorted((a, b) => Number(a) - Number(b)),
      prs,
    );
  });
}

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

test("ledger carry passes a same-tree squash and refuses a different tree", (t) => {
  const root = scratch(t);
  const repo = join(root, "repo");
  const state = join(root, "state");

  mkdirSync(state);
  sh4dow(state);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "switch", "-qc", "unit");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "commit", "-qam", "one");
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "two");
  git(repo, "merge", "-q", "main");

  const verified = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-q", "main");
  git(repo, "merge", "-q", "--squash", "unit");
  git(repo, "commit", "-qm", "squash");

  const squashed = git(repo, "rev-parse", "HEAD");

  writeFileSync(join(repo, "a.txt"), "drift\n");
  git(repo, "commit", "-qam", "drift");

  const drifted = git(repo, "rev-parse", "HEAD");
  const ledger = join(state, "ledger.tsv");

  assert.equal(
    run([
      "--state",
      state,
      "ledger",
      "record",
      "5",
      verified,
      "unit-test-verified",
      "evidence/u5/test.log",
      "--risk",
      "medium",
      "--risk-reason",
      "touches the merge path",
    ]).status,
    0,
  );

  const carried = run(["--state", state, "ledger", "carry", "5", squashed, verified, "-C", repo]);

  assert.equal(carried.status, 0, carried.stderr);
  assert.deepEqual(readFileSync(ledger, "utf8").split("\n")[2]?.split("\t").slice(0, 6), [
    "5",
    squashed,
    "unit-test-verified",
    `carried from ${verified}`,
    "medium",
    "touches the merge path",
  ]);

  const refused = run(["--state", state, "ledger", "carry", "5", drifted, verified, "-C", repo]);

  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /trees differ/);
  assert.equal(
    readFileSync(ledger, "utf8").split("\n").length,
    4,
    "a refused carry writes nothing",
  );
  assert.equal(
    run(["--state", state, "ledger", "carry", "5", drifted, sha("0"), "-C", repo]).status,
    2,
  );

  const plain = join(root, "plain");
  const plainLedger = join(plain, "ledger.tsv");

  mkdirSync(plain);
  writeFileSync(
    plainLedger,
    `${LEDGER_HEADER}\n5\t${verified}\tunit-test-verified\tevidence/u5/test.log\t2026-10-23T19:57:00Z\n`,
  );

  const before = readFileSync(plainLedger, "utf8");

  const plainCarry = run([
    "--state",
    plain,
    "ledger",
    "carry",
    "5",
    squashed,
    verified,
    "-C",
    repo,
  ]);

  assert.equal(plainCarry.status, 0, plainCarry.stderr);

  const after = readFileSync(plainLedger, "utf8");

  assert.ok(after.startsWith(before), "a carry on a five-column ledger only appends");
  assert.deepEqual(after.slice(before.length).split("\t").slice(0, 4), [
    "5",
    squashed,
    "unit-test-verified",
    `carried from ${verified}`,
  ]);
  assert.equal(after.slice(before.length).split("\t").length, 5);
});

test("unit add and set write units.tsv rows in place", (t) => {
  const state = scratch(t);
  const units = join(state, "units.tsv");
  const unit = (...args: string[]) => run(["--state", state, "unit", ...args]);

  assert.equal(unit("add", "u1", "ticket=T1", "brief=briefs/u1.md").status, 0);
  assert.equal(unit("add", "u2", "ticket=T2").status, 0);
  assert.equal(unit("set", "u1", "state=merged", "final_pr=7").status, 0);
  assert.equal(
    readFileSync(units, "utf8"),
    [
      UNITS_HEADER,
      "u1\tT1\t\t7\tmerged\t\t\t\tbriefs/u1.md",
      "u2\tT2\t\t-\tplanned\t\t\t\t",
      "",
    ].join("\n"),
  );

  for (const refused of [
    ["add", "u1", "ticket=T9"],
    ["set", "u9", "state=merged"],
    ["set", "u1", "verdict=pass"],
    ["set", "u1", "state=two\twords"],
    ["set", "u1", "state=finished"],
    ["set", "u1"],
  ]) {
    assert.equal(unit(...refused).status, 2, refused.join(" "));
  }

  assert.equal(
    readFileSync(units, "utf8").split("\n")[1],
    "u1\tT1\t\t7\tmerged\t\t\t\tbriefs/u1.md",
  );
});

test("a missing state folder is refused with exit 2", (t) => {
  const result = run(["--state", join(scratch(t), "absent"), "report"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /state folder missing/);
});
