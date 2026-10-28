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

function routerRows() {
  const router = generalPrompt.match(/<router>\n([\s\S]*?)<\/router>/)?.[1];
  assert.ok(router, "the general prompt has a <router> block");

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

test("the model's skill table holds only principle skills and unslop", () => {
  const visible = readdirSync(skillsDirectory)
    .filter((name) => existsSync(join(skillsDirectory, name, "SKILL.md")))
    .filter((name) => !hiddenFromTheModel(name));

  assert.deepEqual(
    visible.filter((name) => !name.startsWith("principle-") && name !== "unslop"),
    [],
  );
  assert.ok(visible.includes("unslop"));
});
