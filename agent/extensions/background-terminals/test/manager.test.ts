import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processIsGone } from "../../test/process.ts";
import {
  BackgroundTerminalManager,
  MAX_TRACKED,
  RETAINED_BYTES,
  type TerminalSnapshot,
} from "../manager.ts";

const cwd = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
test.after(() => rmSync(cwd, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function settled(
  manager: BackgroundTerminalManager,
  id: string,
  timeout = 6_000,
): Promise<TerminalSnapshot> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = manager.get(id);
    if (snapshot && snapshot.state !== "running") return snapshot;
    await wait(20);
  }
  throw new Error(`timeout waiting for ${id}`);
}

test("captures stdout and stderr and classifies success and nonzero", async () => {
  const manager = new BackgroundTerminalManager();
  const ok = manager.start({
    command: "printf out; printf err >&2",
    title: "ok",
    cwd,
  });
  const bad = manager.start({
    command: "printf nope >&2; exit 7",
    title: "bad",
    cwd,
  });
  assert.equal((await settled(manager, ok.id)).state, "done");
  const failed = await settled(manager, bad.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.exitCode, 7);
  assert.equal(manager.get(ok.id)?.stdout.text, "out");
  assert.equal(manager.get(ok.id)?.stderr.text, "err");
  await manager.shutdown();
});

test("retains a UTF-8-safe newest 256 KiB tail with byte counts", async () => {
  const manager = new BackgroundTerminalManager();
  const bytes = RETAINED_BYTES + 4099;
  const run = manager.start({
    command: `node -e 'process.stdout.write("é".repeat(${Math.ceil(bytes / 2)}))'`,
    title: "large",
    cwd,
  });
  const snapshot = await settled(manager, run.id);
  assert.ok(Buffer.byteLength(snapshot.stdout.text) <= RETAINED_BYTES);
  assert.ok(!snapshot.stdout.text.startsWith("�"));
  assert.equal(
    snapshot.stdout.totalBytes - Buffer.byteLength(snapshot.stdout.text),
    snapshot.stdout.truncatedBytes,
  );
  assert.ok(snapshot.stdout.truncatedBytes > 0);
  await manager.shutdown();
});

test("retains exact newest output after many small writes", async () => {
  const manager = new BackgroundTerminalManager();
  const writes = RETAINED_BYTES + 10_000;
  const run = manager.start({
    command: `node -e 'for(let i=0;i<${writes};i++)process.stdout.write(String(i%10))'`,
    title: "chatty",
    cwd,
  });
  const snapshot = await settled(manager, run.id);
  assert.equal(snapshot.stdout.totalBytes, writes);
  assert.equal(Buffer.byteLength(snapshot.stdout.text), RETAINED_BYTES);
  assert.equal(snapshot.stdout.truncatedBytes, writes - RETAINED_BYTES);
  assert.equal(snapshot.stdout.text.slice(-20), "45678901234567890123");
  await manager.shutdown();
});

test("enforces running and tracked bounds without pruning running entries", async () => {
  const manager = new BackgroundTerminalManager();
  const runs = Array.from({ length: 8 }, (_, index) =>
    manager.start({ command: "sleep 30", title: String(index), cwd }),
  );
  assert.throws(
    () => manager.start({ command: "true", title: "ninth", cwd }),
    /Max 8/,
  );
  await manager.kill(runs.map((run) => run.id));
  for (let index = 0; index < MAX_TRACKED + 3; index++) {
    const run = manager.start({
      command: "true",
      title: `quick-${index}`,
      cwd,
    });
    await settled(manager, run.id);
  }
  assert.equal(manager.list().length, MAX_TRACKED);
  await manager.shutdown();
});

test("repeated and overlapping kills settle once", async () => {
  let notifications = 0;
  const manager = new BackgroundTerminalManager(() => notifications++);
  const run = manager.start({ command: "sleep 30", title: "repeat", cwd });
  const [first, second] = await Promise.all([
    manager.kill([run.id]),
    manager.kill([run.id, run.id]),
  ]);
  assert.equal(first[0].state, "killed");
  assert.equal(second[0].state, "killed");
  assert.equal(notifications, 1);
  await manager.shutdown();
});

test("escalates SIGTERM and cleans the POSIX process group", {
  skip: process.platform === "win32",
}, async () => {
  const manager = new BackgroundTerminalManager();
  const run = manager.start({
    command: "trap '' TERM; sleep 30 & echo child:$!; wait",
    title: "stubborn",
    cwd,
  });
  await wait(100);
  const childPid = Number(
    /child:(\d+)/.exec(manager.get(run.id)?.stdout.text ?? "")?.[1],
  );
  assert.ok(childPid);
  const started = Date.now();
  await manager.kill([run.id]);
  const snapshot = manager.get(run.id);
  assert.equal(snapshot?.state, "killed");
  assert.ok(Date.now() - started >= 1_800);
  assert.ok(Date.now() - started < 5_000);
  for (let attempt = 0; attempt < 50 && !processIsGone(childPid); attempt++)
    await wait(20);
  assert.ok(processIsGone(childPid));
  await manager.shutdown();
});

test("shutdown kills a process group after its shell exits", {
  skip: process.platform === "win32",
}, async () => {
  const manager = new BackgroundTerminalManager();
  const run = manager.start({
    command: "sleep 30 >/dev/null 2>&1 & echo child:$!",
    title: "detached descendant",
    cwd,
  });
  let childPid = 0;
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const snapshot = manager.get(run.id);
      childPid = Number(/child:(\d+)/.exec(snapshot?.stdout.text ?? "")?.[1]);
      if (childPid && run.pid && processIsGone(run.pid)) break;
      await wait(20);
    }
    assert.ok(childPid);
    assert.ok(run.pid && processIsGone(run.pid));
    assert.ok(!processIsGone(childPid));
    await manager.shutdown();
    for (let attempt = 0; attempt < 50 && !processIsGone(childPid); attempt++)
      await wait(20);
    assert.ok(processIsGone(childPid));
  } finally {
    if (childPid && !processIsGone(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
  }
});

test("shutdown kills running processes without delivering completion", async () => {
  let notifications = 0;
  const manager = new BackgroundTerminalManager(() => notifications++);
  const run = manager.start({ command: "sleep 30", title: "shutdown", cwd });
  assert.ok(run.pid);
  await manager.shutdown();
  assert.equal(manager.list().length, 0);
  assert.equal(notifications, 0);
  assert.ok(processIsGone(run.pid));
});

test("releases inherited pipe handles after bounded termination", {
  skip: process.platform === "win32",
}, async () => {
  const manager = new BackgroundTerminalManager();
  const run = manager.start({
    command:
      'node -e \'const {spawn}=require("node:child_process");const child=spawn("sleep",["30"],{detached:true,stdio:["ignore",1,2]});console.log("escaped:"+child.pid);child.unref()\'',
    title: "escaped pipes",
    cwd,
  });
  let escapedPid = 0;
  try {
    const snapshot = await settled(manager, run.id, 6_000);
    escapedPid = Number(/escaped:(\d+)/.exec(snapshot.stdout.text)?.[1]);
    assert.ok(escapedPid);
    const entries = (
      manager as unknown as { entries: Map<string, { child: ChildProcess }> }
    ).entries;
    assert.equal(entries.get(run.id)?.child.stdout?.destroyed, true);
    assert.equal(entries.get(run.id)?.child.stderr?.destroyed, true);
  } finally {
    await manager.shutdown();
    if (escapedPid && !processIsGone(escapedPid)) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {}
    }
  }
});

test("bounds settlement when descendants retain inherited pipes", {
  skip: process.platform === "win32",
}, async () => {
  const manager = new BackgroundTerminalManager();
  const run = manager.start({
    command: "(sleep 30) & exit 0",
    title: "pipes",
    cwd,
  });
  const snapshot = await settled(manager, run.id, 5_000);
  assert.equal(snapshot.state, "done");
  assert.ok((snapshot.settledAt ?? 0) - snapshot.createdAt < 4_500);
  await manager.shutdown();
});
