import assert from "node:assert/strict";
import test from "node:test";

import config from "../../vite.config.ts";
import { EVAL_FIXTURE_FOLDERS } from "../eval-fixture-folders.ts";

function evalIgnores(patterns: readonly string[] | undefined) {
  return (patterns ?? []).filter((pattern) => pattern.startsWith("evals/")).toSorted();
}

test("the shared list holds today's eval fixture folders and leaves out setup and results", () => {
  const listed: readonly string[] = EVAL_FIXTURE_FOLDERS;

  for (const folder of ["fixtures", "changes", "defects"]) {
    assert.ok(listed.includes(folder), `${folder} is missing from the list`);
  }

  for (const folder of ["setup", "results"]) {
    assert.ok(!listed.includes(folder), `${folder} is in the list`);
  }
});

test("fmt and lint skip every listed folder, and beyond it only setup and results", () => {
  const expected = [
    ...EVAL_FIXTURE_FOLDERS.map((folder) => `evals/*/${folder}/**`),
    "evals/*/setup/**",
    "evals/*/results/**",
  ].toSorted();

  assert.deepEqual(evalIgnores(config.fmt?.ignorePatterns), expected);
  assert.deepEqual(evalIgnores(config.lint?.ignorePatterns), expected);
});
