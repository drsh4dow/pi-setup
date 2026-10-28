import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const checker = new URL("../verify-role-models.ts", import.meta.url).pathname;

const SKILL = new URL("../../agent/skills/subagents/SKILL.md", import.meta.url).pathname;

const skill = readFileSync(SKILL, "utf8");

interface Run {
  readonly status: number | null;
  readonly stderr: string;
}

function check(t: TestContext, text?: string): Run {
  const args = [checker];

  if (text !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), "verify-role-models-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const path = join(dir, "SKILL.md");
    writeFileSync(path, text);
    args.push(path);
  }

  const result = spawnSync(process.execPath, args, { encoding: "utf8" });

  return { status: result.status, stderr: result.stderr };
}

function edited(from: string, to: string): string {
  assert.ok(skill.includes(from), `the subagents skill holds ${JSON.stringify(from)}`);

  return skill.replace(from, to);
}

test("the subagents skill's Models section agrees with the launcher's role table", (t) => {
  const run = check(t);

  assert.equal(run.status, 0, run.stderr);
});

test("a role the Models section moves to the other model fails the check", (t) => {
  const run = check(t, edited("`verifier`,", ""));

  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /verifier/);
  assert.match(run.stderr, /anthropic\/claude-opus-5-5/);
  assert.match(run.stderr, /openai\/gpt-6\.1-sol/);
});

test("another model for every other role fails the check for a role it covers", (t) => {
  const run = check(
    t,
    edited("- `anthropic/claude-opus-5-5` has taste", "- `anthropic/claude-opus-6` has taste"),
  );

  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /implementer/);
  assert.match(run.stderr, /anthropic\/claude-opus-6/);
});

test("another thinking level fails the check", (t) => {
  const run = check(t, edited("runs at `--thinking high`", "runs at `--thinking medium`"));

  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /--thinking medium/);
});

test("a skill without a Models section fails the check", (t) => {
  const run = check(t, skill.replace(/^## Models$/m, "## Model choice"));

  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /## Models/);
});
