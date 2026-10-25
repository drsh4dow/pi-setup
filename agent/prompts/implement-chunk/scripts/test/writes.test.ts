import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LEDGER_HEADER, UNITS_HEADER, promptsDir, run, scratch, sha } from "./harness.ts";

test("the prompt names the columns the CLI writes", () => {
  const prompt = readFileSync(join(promptsDir, "implement-chunk.md"), "utf8");

  const columns = (file: string) =>
    prompt
      .match(new RegExp(`\`${file}\` columns: \`([^\`]+)\``))?.[1]
      ?.split(" ")
      .join("\t");

  assert.equal(columns("units.tsv"), UNITS_HEADER);
  assert.equal(columns("ledger.tsv"), LEDGER_HEADER);
});

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
    ]).status,
    0,
  );

  const carried = run(["--state", state, "ledger", "carry", "5", squashed, verified, "-C", repo]);

  assert.equal(carried.status, 0, carried.stderr);
  assert.deepEqual(readFileSync(ledger, "utf8").split("\n")[2]?.split("\t").slice(0, 4), [
    "5",
    squashed,
    "unit-test-verified",
    `carried from ${verified}`,
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
    [UNITS_HEADER, "u1\tT1\t\t7\tmerged\t\t\t\tbriefs/u1.md", "u2\tT2\t\t\t\t\t\t\t", ""].join(
      "\n",
    ),
  );

  for (const refused of [
    ["add", "u1", "ticket=T9"],
    ["set", "u9", "state=merged"],
    ["set", "u1", "verdict=pass"],
    ["set", "u1", "state=two\twords"],
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
