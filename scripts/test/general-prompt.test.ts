import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const root = new URL("../..", import.meta.url).pathname;

// Pi reads the agent directory's SYSTEM.md as every general session's system prompt.
const generalPrompt = readFileSync(join(root, "agent/SYSTEM.md"), "utf8");

const skillsDirectory = join(root, "agent/skills");

function hiddenFromTheModel(name: string) {
  const { frontmatter } = parseFrontmatter<{ "disable-model-invocation"?: unknown }>(
    readFileSync(join(skillsDirectory, name, "SKILL.md"), "utf8"),
  );

  return frontmatter["disable-model-invocation"] === true;
}

function routerBlock() {
  const router = generalPrompt.match(/<router>\n([\s\S]*?)<\/router>/)?.[1];
  assert.ok(router, "the general prompt has a <router> block");

  return router;
}

function routerRows() {
  const router = routerBlock();
  const table = router.split("\n").filter((line) => line.startsWith("|"));
  assert.equal(table[0], "| Task | Skill |");

  return table.slice(2).map((line) => {
    const [task, skill] = line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());

    return { task, skill };
  });
}

test("the general prompt routes through a router, with no skill_workflow and no coordinator rules", () => {
  assert.match(generalPrompt, /^<router>$/m);
  assert.doesNotMatch(generalPrompt, /<skill_workflow>|small chance of applying/);

  for (const coordinatorRule of [
    "# Implement a chunk",
    "## Drain points",
    "## Escalation",
    "## Tree",
  ]) {
    assert.ok(!generalPrompt.includes(coordinatorRule), `general prompt holds ${coordinatorRule}`);
  }

  assert.match(generalPrompt, /<collaboration>/);
});

// Blinded general-mode runs that opened the reply with the routed skill's steps were marked
// down for process narration, so the steps stay out of the reply and only the exceptions show.
test("the router keeps a workflow's steps out of the reply, and ends it with the skipped or no-match line", () => {
  const instructions = routerBlock()
    .split("\n")
    .filter((line) => !line.startsWith("|"))
    .join("\n");

  assert.doesNotMatch(
    instructions,
    /todolist|open your reply with (that|the) skill|open your reply with `No workflow/i,
  );
  assert.match(instructions, /open(s)? with the answer/);
  assert.match(
    instructions,
    /end your reply with one line, `Skipped: <step> \(<reason>\)`, joining several steps with `; `/,
  );
  assert.match(instructions, /end your reply with the line `No workflow matched\.`/);
});

test("each router row names one skill by path, and that skill is hidden from the model's table", () => {
  const rows = routerRows();
  assert.ok(rows.length > 0);

  for (const { task, skill } of rows) {
    const name = skill.match(/^`~\/\.pi\/agent\/skills\/([a-z0-9-]+)\/SKILL\.md`$/)?.[1];
    assert.ok(name, `row "${task}" names no skill path: ${skill}`);
    assert.ok(existsSync(join(skillsDirectory, name, "SKILL.md")), `row "${task}": no ${name}`);
    assert.ok(hiddenFromTheModel(name), `row "${task}": ${name} is in the model's skill table`);
  }
});

// The visible set the router ticket selected: each skill here loaded in the coordinator-runs
// baseline's skill reads, in the principle-loading `full` runs, or in both.
const SELECTED_VISIBLE_SKILLS = [
  "principle-attack-the-premise",
  "principle-boundary-discipline",
  "principle-build-the-lever",
  "principle-encode-lessons-in-structure",
  "principle-engineering-standards",
  "principle-exhaust-the-design-space",
  "principle-experience-first",
  "principle-explain-the-number",
  "principle-fix-root-causes",
  "principle-laziness-protocol",
  "principle-make-operations-idempotent",
  "principle-minimize-reader-load",
  "principle-model-the-domain",
  "principle-prove-it-works",
  "principle-redesign-from-first-principles",
  "principle-separate-before-serializing-shared-state",
  "principle-sequence-verifiable-units",
  "principle-test-behavior-not-implementation",
  "unslop",
];

test("the model's skill table holds exactly the selected principle skills and unslop", () => {
  const visible = readdirSync(skillsDirectory)
    .filter((name) => existsSync(join(skillsDirectory, name, "SKILL.md")))
    .filter((name) => !hiddenFromTheModel(name))
    .toSorted();

  assert.deepEqual(visible, SELECTED_VISIBLE_SKILLS);
});
