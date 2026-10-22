import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { projectChanges } from "../../lib/pi-run.ts";
import { onPort, prepareWorkdir } from "../run.ts";
import { fixturePorts, scenarios } from "../scenarios.ts";

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

test("runs on the same port never overlap, and runs on other ports start at once", async () => {
  const events: string[] = [];

  const task = (name: string) => async () => {
    events.push(`start ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push(`end ${name}`);
  };

  await Promise.all([
    onPort(3000, task("a")),
    onPort(3000, task("b")),
    onPort(undefined, task("c")),
  ]);

  assert.ok(events.indexOf("end a") < events.indexOf("start b"));
  assert.ok(events.indexOf("start c") < events.indexOf("end a"));
});

test("every fixture that listens on a fixed port declares it", () => {
  const fixtures = join(import.meta.dirname, "..", "fixtures");

  const listening = new Map<string, number>();

  for (const fixture of readdirSync(fixtures)) {
    for (const file of readdirSync(join(fixtures, fixture), { recursive: true }).map(String)) {
      if (!/\.(ts|js)$/.test(file)) continue;

      const port = readFileSync(join(fixtures, fixture, file), "utf8").match(
        /\.listen\(([1-9]\d*)/,
      )?.[1];

      if (port !== undefined) listening.set(fixture, Number(port));
    }
  }

  assert.deepEqual(
    [...listening].toSorted(([a], [b]) => a.localeCompare(b)),
    [...fixturePorts].toSorted(([a], [b]) => a.localeCompare(b)),
  );
});
