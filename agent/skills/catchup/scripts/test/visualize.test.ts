import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../visualize.ts", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function scratch(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visualize-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const visualize = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });

test("draws each chart as a PNG next to it and prints its absolute path", () => {
  const dir = scratch({
    "bars.mmd": 'xychart-beta\n  x-axis ["Before", "After"]\n  bar [840, 35]\n',
    "tests.mmd": 'pie\n  "Pass" : 11\n  "Skipped" : 1\n',
  });
  const r = visualize(dir, "bars.mmd", "tests.mmd");

  assert.equal(r.status, 0, r.stderr);
  const printed = r.stdout.trim().split("\n");
  assert.deepEqual(printed, [path.join(dir, "bars.png"), path.join(dir, "tests.png")]);
  for (const png of printed) assert.deepEqual(fs.readFileSync(png).subarray(0, 8), PNG_SIGNATURE);
});

test("exits 1 on a chart that does not parse, and still draws the others", () => {
  const dir = scratch({ "bad.mmd": "xychart-beta\n  bar [1, oops\n", "ok.mmd": "pie\n  \"A\" : 1\n" });
  const r = visualize(dir, "bad.mmd", "ok.mmd");

  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not draw bad\.mmd/);
  assert.ok(fs.existsSync(path.join(dir, "ok.png")));
  assert.ok(!fs.existsSync(path.join(dir, "bad.png")));
});

test("exits 2 when it cannot run: no input, or a file it cannot read", () => {
  const dir = scratch({});
  assert.equal(visualize(dir).status, 2);

  const missing = visualize(dir, "missing.mmd");
  if (missing.status !== 2) assert.fail(`expected exit 2, got ${missing.status}`);
  assert.match(missing.stderr, /missing\.mmd/);
});
