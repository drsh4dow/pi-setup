import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";

import { promptRole, ROLES } from "../../agent/skills/subagents/scripts/brief.ts";

const root = new URL("../..", import.meta.url).pathname;

const KINDS = ["delegate", "owner"] as const;

// Each role part is agent/system/roles/<kind>/<role>.md, so its directory is its kind.
const roleParts = KINDS.flatMap((kind) =>
  readdirSync(join(root, "agent/system/roles", kind))
    .filter((file) => file.endsWith(".md"))
    .map((file) => ({ kind, role: basename(file, ".md") })),
);

// The core's text between its slot lines: every block a role prompt shares with general mode.
const coreBlocks = readFileSync(join(root, "agent/system/core.md"), "utf8")
  .split(/^<!-- slot: \S+ -->$/mu)
  .map((block) => block.trim())
  .filter((block) => block !== "");

test("every launcher role runs on one role part, and every role part is a launcher role", () => {
  assert.deepEqual(
    roleParts.map(({ role }) => role).toSorted(),
    [...new Set(ROLES.map(promptRole))].toSorted(),
  );
});

for (const { kind, role } of roleParts) {
  const prompt = readFileSync(join(root, "agent/system/generated", kind, `${role}.md`), "utf8");

  test(`the ${role} prompt holds the whole core and no general-mode part`, () => {
    assert.ok(coreBlocks.length >= 2, "the core has text on both sides of its slots");

    for (const block of coreBlocks) assert.ok(prompt.includes(block), block.slice(0, 80));

    for (const general of ["<collaboration>", "<skill_workflow>", "<router>"])
      assert.ok(!prompt.includes(general), `${role} prompt holds ${general}`);
  });

  test(`the ${role} prompt says where to read a skill by path`, () => {
    assert.ok(prompt.includes("~/.pi/agent/skills/<name>/SKILL.md"), prompt);
    assert.ok(prompt.includes(".agents/skills/<name>/SKILL.md"), prompt);
  });
}
