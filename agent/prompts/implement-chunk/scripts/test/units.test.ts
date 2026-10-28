import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { type Run, UNITS_HEADER, cli, run, scratch } from "./harness.ts";

function unitsTable(state: string, count: number): void {
  const rows = Array.from({ length: count }, (_, index) =>
    [`u${index}`, `T${index}`, "open", "-", "planned", "", "", "", ""].join("\t"),
  );

  writeFileSync(join(state, "units.tsv"), [UNITS_HEADER, ...rows, ""].join("\n"));
}

function unitStates(state: string): Map<string, string> {
  const lines = readFileSync(join(state, "units.tsv"), "utf8").trimEnd().split("\n").slice(1);

  return new Map(
    lines.map((line) => line.split("\t")).map((cells) => [cells[0] ?? "", cells[4] ?? ""]),
  );
}

function runAtOnce(args: readonly string[]): Promise<Run> {
  const child = spawn(cli, args);
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve) =>
    child.on("close", (status) => resolve({ status, stdout, stderr })),
  );
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);

  assert.equal(child.status, 0);

  return child.pid ?? assert.fail("no pid for the exited child");
}

test("unit set calls made at once on distinct rows all land", async (t) => {
  const state = scratch(t);
  const writers = 16;

  unitsTable(state, 20_000);

  const targets = Array.from({ length: writers }, (_, index) => `u${index * 1000}`);

  const results = await Promise.all(
    targets.map((id) => runAtOnce(["--state", state, "unit", "set", id, "state=merged"])),
  );

  for (const result of results) assert.equal(result.status, 0, result.stderr);

  const states = unitStates(state);
  const lost = targets.filter((id) => states.get(id) !== "merged");

  assert.deepEqual(lost, [], `${lost.length} of ${writers} updates lost`);
  assert.equal(states.size, 20_000);
  assert.equal(states.get("u1"), "planned");
  assert.deepEqual(readdirSync(state), ["units.tsv"]);
});

test("a units.tsv lock held by a running process refuses the write after the wait", (t) => {
  const state = scratch(t);
  const lock = join(state, "units.tsv.lock");

  unitsTable(state, 3);

  const before = readFileSync(join(state, "units.tsv"), "utf8");

  writeFileSync(lock, `${process.pid}\n`);

  const result = run(["--state", state, "unit", "set", "u1", "state=merged"]);

  assert.equal(result.status, 2, result.stderr);
  assert.ok(result.stderr.includes(lock), result.stderr);
  assert.ok(result.stderr.includes(`pid ${process.pid}`), result.stderr);
  assert.equal(readFileSync(join(state, "units.tsv"), "utf8"), before);
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`);
});

test("a units.tsv lock left by a process that has ended refuses the write until it is removed", (t) => {
  const state = scratch(t);
  const lock = join(state, "units.tsv.lock");
  const pid = deadPid();

  unitsTable(state, 3);
  writeFileSync(lock, `${pid}\n`);

  const before = readFileSync(join(state, "units.tsv"), "utf8");
  const refused = run(["--state", state, "unit", "set", "u1", "state=merged"]);

  assert.equal(refused.status, 2, refused.stderr);
  assert.ok(refused.stderr.includes(lock), refused.stderr);
  assert.ok(refused.stderr.includes(`pid ${pid}`), refused.stderr);
  assert.equal(readFileSync(join(state, "units.tsv"), "utf8"), before);
  assert.equal(readFileSync(lock, "utf8"), `${pid}\n`);
  assert.deepEqual(readdirSync(state).toSorted(), ["units.tsv", "units.tsv.lock"]);

  rmSync(lock);

  const rerun = run(["--state", state, "unit", "set", "u1", "state=merged"]);

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(unitStates(state).get("u1"), "merged");
  assert.deepEqual(readdirSync(state), ["units.tsv"]);
});

test("a refused unit write releases the lock", (t) => {
  const state = scratch(t);

  unitsTable(state, 3);

  assert.equal(run(["--state", state, "unit", "set", "u9", "state=merged"]).status, 2);
  assert.equal(run(["--state", state, "unit", "add", "u1", "ticket=T9"]).status, 2);
  assert.deepEqual(readdirSync(state), ["units.tsv"]);
  assert.equal(run(["--state", state, "unit", "set", "u1", "state=merged"]).status, 0);
});
