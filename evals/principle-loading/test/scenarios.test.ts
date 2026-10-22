import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { prepareWorkdir } from "../run.ts";
import { scenarios } from "../scenarios.ts";

const HERE = join(import.meta.dirname, "..");

const SKILLS = join(HERE, "..", "..", "agent", "skills");

// Words that would tell the candidate it is being measured.
const META_WORDS =
  /\b(eval|test harness|judge|experiment|rubric|score|benchmark|candidate|arena|principle|skill)s?\b/i;

test("every principle skill has exactly one scenario", () => {
  const principles = readdirSync(SKILLS)
    .filter((name) => name.startsWith("principle-"))
    .toSorted();

  const targets = scenarios.map((scenario) => scenario.target).toSorted();

  assert.deepEqual(targets, principles);
});

test("prompts carry no meta words", () => {
  const leaking = scenarios
    .filter((scenario) => META_WORDS.test(scenario.prompt))
    .map((scenario) => scenario.target);

  assert.deepEqual(leaking, []);
});

for (const scenario of scenarios) {
  test(`${scenario.target}: its working directory builds and names no meta word`, () => {
    const workdir = prepareWorkdir(scenario);

    try {
      const paths = readdirSync(workdir, { recursive: true })
        .map(String)
        .filter((path) => !path.startsWith(".git"));

      assert.ok(existsSync(join(workdir, ".git")));
      assert.deepEqual(
        paths.filter((path) => META_WORDS.test(path.replaceAll(/[/._-]/g, " "))),
        [],
      );
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
}
