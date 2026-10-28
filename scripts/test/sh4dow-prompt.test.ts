import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ROLES } from "../../agent/skills/subagents/scripts/brief.ts";

const root = new URL("../../", import.meta.url);

const read = (path: string) => readFileSync(new URL(path, root), "utf8");

const CORE_BLOCKS = ["codemode", "state", "git", "guardrails", "context"];

const REQUIRED_COORDINATOR_HEADINGS = [
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
  const coordinatorOrder = headings.filter((line) => REQUIRED_COORDINATOR_HEADINGS.includes(line));
  assert.deepEqual(coordinatorOrder, REQUIRED_COORDINATOR_HEADINGS);
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

/** The text of a `## ` section of the generated sh4dow prompt, up to the next `## ` heading. */
function section(heading: string): string {
  const prompt = read("agent/system/generated/sh4dow.md");
  const text = prompt.split(new RegExp(`^## ${heading}$`, "m"))[1]?.split(/^## /m)[0];
  assert.ok(text, `the sh4dow prompt has no ## ${heading}`);

  return text;
}

test("the tree is flat up to one final PR of six tickets and deep past it, with one owner per final PR", () => {
  const tree = section("Tree");
  const flat = tree.match(/^- \*\*Flat\*\*: (.*)$/m)?.[1] ?? "";
  const deep = tree.match(/^- \*\*Deep\*\*: (.*)$/m)?.[1] ?? "";

  assert.match(flat, /^one final PR with six tickets or fewer\./);
  assert.match(deep, /^two or more final PRs, or more than six tickets\./);
  assert.match(deep, /one `final-pr-owner` per final PR with `--kind owner`/);
});

test("the coordinator drains its inbox at the four drain points", () => {
  const points = section("Drain points").match(/^\d+\. \*\*[^*]+\*\*/gm) ?? [];

  assert.deepEqual(points, [
    "1. **After recording a completion.**",
    "2. **At each owner rollup.**",
    "3. **On each watcher wake.**",
    "4. **Before every message to the user.**",
  ]);
});

test("close audits the decision trail and has a cross-family reviewer write the Attention flags", () => {
  const close = section("Steps").split(/^### 8\. Close$/m)[1] ?? "";

  assert.match(close, /\*\*show-me-your-work\*\*/);
  assert.match(close, /decisions\.tsv/);
  assert.match(close, /\$PI_SESSION_FILE/);
  assert.match(close, /`--role cross-family-reviewer`/);
  assert.match(close, /`<state folder>\/attention\.md`/);
});

/** The model the subagents skill's Models section gives the `cross-family-reviewer` role. */
function crossFamilyModel(): string {
  const models =
    read("agent/skills/subagents/SKILL.md")
      .split(/^## Models$/m)[1]
      ?.split(/^## /m)[0] ?? "";

  const bullet = models
    .split(/\n(?=- )/)
    .find((item) => item.includes("runs `cross-family-reviewer`"));

  const model = bullet?.match(/^- `([^`]+)`/)?.[1];
  assert.ok(
    model,
    "the subagents skill's Models section names no model for `cross-family-reviewer`",
  );

  return model;
}

test("each cross-family reviewer the sh4dow prompts name launches with a launcher role, and only a role without its own model names one", () => {
  const model = crossFamilyModel();

  for (const path of [
    "agent/system/generated/sh4dow.md",
    "agent/system/generated/owner/final-pr-owner.md",
  ]) {
    const text = read(path);

    const sentences = text
      .split(/\n|(?<=\.)\s+(?=[A-Z`(])/)
      .filter((sentence) => /cross-family[ -]reviewer/.test(sentence));

    assert.ok(sentences.length > 0, `${path} names no cross-family reviewer`);
    assert.doesNotMatch(text, /--role assignment --model/, path);

    for (const sentence of sentences) {
      const roles = [...sentence.matchAll(/--role ([a-z-]+)/g)].map((match) => match[1] ?? "");

      assert.ok(roles.length > 0, `${path}: no --role in: ${sentence}`);

      for (const role of roles)
        assert.ok(
          ROLES.some((known) => known === role),
          `${path}: --role ${role}`,
        );

      if (roles.includes("cross-family-reviewer"))
        assert.doesNotMatch(sentence, /--model/, `${path}: the role brings its model: ${sentence}`);
      else
        assert.ok(
          sentence.includes(`--model ${model}`),
          `${path}: no --model ${model} in: ${sentence}`,
        );
    }
  }
});

test("close starts the cross-family review after the trail audit, on the audited trail", () => {
  const close = section("Steps").split(/^### 8\. Close$/m)[1] ?? "";
  const check = close.split(/^2\. /m)[1]?.split(/^3\. /m)[0] ?? "";
  const audit = check.match(/^ {3}1\. (.*)$/m)?.[1] ?? "";
  const review = check.match(/^ {3}2\. (.*)$/m)?.[1] ?? "";

  assert.match(audit, /^Audit `decisions\.tsv`/);
  assert.match(review, /^(After|Once)\b.*?\baudit\b.*?, launch /, "the review waits on the audit");
  assert.match(review, /the audited `decisions\.tsv`/);
  assert.match(review, /`--role cross-family-reviewer`/);
  assert.doesNotMatch(review, /--model/, "the role brings its model");
});
