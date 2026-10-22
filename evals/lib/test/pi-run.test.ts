import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { killProcessesIn } from "../pi-run.ts";

test("a process left running in a run's directory in its own group is killed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "leftover-"));
  const outside = mkdtempSync(join(tmpdir(), "bystander-"));
  const leftover = spawn("sleep", ["60"], { cwd: directory, detached: true, stdio: "ignore" });
  const bystander = spawn("sleep", ["60"], { cwd: outside, detached: true, stdio: "ignore" });

  try {
    const exited = new Promise((resolve) =>
      leftover.on("exit", (_code, signal) => resolve(signal)),
    );

    assert.deepEqual(killProcessesIn(directory), [leftover.pid]);
    assert.equal(await exited, "SIGKILL");
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null);
  } finally {
    bystander.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
