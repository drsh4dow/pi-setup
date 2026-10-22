import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { prepareWorkdir, projectChanges } from "../run.ts";
import { scenarios } from "../scenarios.ts";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("project changes count edited files and commits on any branch since setup", () => {
  const scenario = scenarios.find((candidate) => candidate.fixture === "config-loader");

  assert.ok(scenario);

  const workdir = prepareWorkdir(scenario);

  try {
    const setupHead = git(workdir, ["rev-parse", "HEAD"]);

    assert.equal(projectChanges(workdir, setupHead), 0);

    writeFileSync(join(workdir, "README.md"), "changed\n");
    writeFileSync(join(workdir, "NOTES.md"), "new\n");

    assert.equal(projectChanges(workdir, setupHead), 2);

    git(workdir, ["checkout", "-qb", "feature"]);
    git(workdir, ["add", "-A"]);
    git(workdir, ["commit", "-qm", "change"]);
    git(workdir, ["checkout", "-q", "main"]);

    assert.equal(projectChanges(workdir, setupHead), 1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
