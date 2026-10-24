import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { harnessArgs, selectScenarios } from "../run.ts";
import { scenarioById, scenarios } from "../scenarios.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The directories passed to `--skill`, in order. */
function skillPaths(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === "--skill" ? [arg] : []));
}

test("a clone run loads the arm's skills and the clone's own project skills", () => {
  const args = harnessArgs({
    scenario: scenarioById("skill-tuning-method"),
    armRoot: ROOT,
    workdir: "/tmp/pi-setup-abc",
  });

  assert.ok(args.includes("--no-skills"));
  assert.deepEqual(skillPaths(args), [
    join(ROOT, "agent", "skills"),
    "/tmp/pi-setup-abc/.agents/skills",
  ]);
});

test("a fixture run loads only the arm's skills", () => {
  const args = harnessArgs({
    scenario: scenarioById("hand-edits-use-edit"),
    armRoot: ROOT,
    workdir: "/tmp/fixture-abc",
  });

  assert.deepEqual(skillPaths(args), [join(ROOT, "agent", "skills")]);
});

const ids = (only?: string[]) => selectScenarios(only).map((scenario) => scenario.id);

test("cosmetic-wake runs only when --only names it", () => {
  assert.ok(!ids().includes("cosmetic-wake"));
  assert.equal(ids().length, scenarios.length - 1);
  assert.deepEqual(ids(["cosmetic-wake", "cross-project"]), ["cross-project", "cosmetic-wake"]);
});
