import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const checker = new URL("../verify-skills.ts", import.meta.url).pathname;

function repository(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "verify-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, contents, { mode: 0o644 });
  }

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });

  return root;
}

function run(cwd: string) {
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
}

function assertNamesFix(stderr: string, scripts: readonly string[]) {
  for (const script of scripts) {
    assert.match(stderr, new RegExp(`${script}: .*Run: chmod \\+x ${script} && git add ${script}`));
  }
}

test("requires the executable bit on shebang skill scripts in the index and on disk", (t) => {
  const scripts = [
    "agent/skills/example/scripts/log.sh",
    ".agents/skills/verify-example/scripts/check",
  ];

  const root = repository(t, {
    [scripts[0]]: "#!/usr/bin/env bash\n",
    [scripts[1]]: "#!/usr/bin/env node\n",
    "agent/skills/example/scripts/data.tsv": "phase\tdecision\n",
    "agent/scripts/tool.ts": "#!/usr/bin/env node\n",
  });

  const missing = run(join(root, "agent"));
  assert.notEqual(missing.status, 0);
  assertNamesFix(missing.stderr, scripts);
  assert.doesNotMatch(missing.stderr, /data\.tsv|agent\/scripts\/tool\.ts/);

  execFileSync("git", ["update-index", "--chmod=+x", ...scripts], { cwd: root });
  const indexOnly = run(root);
  assert.notEqual(indexOnly.status, 0);
  assertNamesFix(indexOnly.stderr, scripts);

  for (const script of scripts) chmodSync(join(root, script), 0o755);
  execFileSync("git", ["add", ...scripts], { cwd: root });
  const executable = run(root);
  assert.equal(executable.status, 0, executable.stderr);
});
