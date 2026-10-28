import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);

const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const CORE_BLOCKS = ["codemode", "state", "git", "guardrails", "context"];

// The coordinator part's top-level headings, in order. Later tickets fill some of them.
const COORDINATOR_HEADINGS = [
  "## Your role",
  "## State folder",
  "## Steps",
  "## Tree",
  "## Drain points",
  "## Verification",
  "## Escalation",
  "## Reply",
];

function block(text: string, tag: string): string {
  const found = text.match(new RegExp(`<${tag}>\\n[\\s\\S]*?\\n</${tag}>`))?.[0];
  assert.ok(found, `core.md has no <${tag}> block`);

  return found;
}

test("the sh4dow prompt carries every core block word for word", () => {
  const core = read("agent/system/core.md");
  const prompt = read("agent/system/generated/sh4dow.md");

  for (const tag of CORE_BLOCKS) assert.ok(prompt.includes(block(core, tag)), `<${tag}>`);
  assert.ok(prompt.startsWith(core.split("\n").slice(0, 2).join("\n")), "identity lines");
});

test("the sh4dow prompt carries the coordinator part and none of the general part", () => {
  const prompt = read("agent/system/generated/sh4dow.md");
  const general = read("agent/system/general.md");

  for (const tag of ["collaboration", "skill_workflow", "router", "available_skills"]) {
    assert.ok(!prompt.includes(`<${tag}>`), `<${tag}> must stay out`);
  }

  for (const tag of ["collaboration", "skill_workflow"]) {
    const generalBlock = general.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`))?.[0];

    if (!generalBlock) continue;
    const firstRule = generalBlock.split("\n").find((line) => line.length > 40);
    assert.ok(firstRule && !prompt.includes(firstRule), `a line of <${tag}> leaked in`);
  }

  const headings = prompt.split("\n").filter((line) => line.startsWith("## "));
  const coordinatorOrder = headings.filter((line) => COORDINATOR_HEADINGS.includes(line));
  assert.deepEqual(coordinatorOrder, COORDINATOR_HEADINGS);
});

test("the last step of the coordinator part is Close", () => {
  const part = read("agent/system/sh4dow.md");
  const steps = part.split(/^## Steps$/m)[1]?.split(/^## /m)[0] ?? "";
  const stepHeadings = steps.split("\n").filter((line) => line.startsWith("### "));

  assert.equal(stepHeadings.at(-1), "### 8. Close");
});

test("the coordinator part states its own rules without overriding another prompt's", () => {
  const part = read("agent/system/sh4dow.md");

  assert.doesNotMatch(
    part,
    /overrid|supersede|takes precedence|instead of (the|your) (system prompt|usual)|general[- ]mode|collaboration cases|<collaboration>|skill table says/i,
  );
});
