import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import config from "../../vite.config.ts";
import { EVAL_FIXTURE_FOLDERS } from "../eval-fixture-folders.ts";

const verifyDocs = new URL("../verify-docs.ts", import.meta.url).pathname;

const brokenReadme = "See [design](docs/design.md).\n";

// The smallest tree verify-docs accepts, plus the given files, tracked in a fresh git repository.
function repository(t: TestContext, extraFiles: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "eval-fixture-folders-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const files = {
    "docs/inventory.md": [
      "# Inventory",
      "### Installed extensions",
      "- `example`",
      "### Installed skills",
      "- `example`",
      "### Installed prompts",
      "- `example`",
      "### Installed themes",
      "- `example`",
      "",
    ].join("\n\n"),
    "agent/extensions/example/index.ts": "",
    "agent/skills/example/SKILL.md": "# Example\n",
    "agent/prompts/example.md": "# Example\n",
    "agent/themes/example.json": "{}\n",
    ...extraFiles,
  };

  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, contents);
  }

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });

  return root;
}

function runVerifyDocs(root: string) {
  return spawnSync(process.execPath, [verifyDocs], { cwd: root, encoding: "utf8" });
}

const evalIgnores = (patterns: readonly string[] | undefined) =>
  (patterns ?? []).filter((pattern) => pattern.startsWith("evals/")).toSorted();

test("the shared list holds today's eval fixture folders and not setup", () => {
  assert.deepEqual([...EVAL_FIXTURE_FOLDERS].toSorted(), ["changes", "defects", "fixtures"]);
});

test("fmt and lint skip every listed folder, and beyond it only setup and results", () => {
  const expected = [
    ...EVAL_FIXTURE_FOLDERS.map((folder) => `evals/*/${folder}/**`),
    // Outside the list: setup/ is real shell code the evals run, results/ is gitignored output.
    "evals/*/setup/**",
    "evals/*/results/**",
  ].toSorted();

  assert.deepEqual(evalIgnores(config.fmt?.ignorePatterns), expected);
  assert.deepEqual(evalIgnores(config.lint?.ignorePatterns), expected);
});

test("verify-docs skips a broken link under every listed folder", (t) => {
  const root = repository(
    t,
    Object.fromEntries(
      EVAL_FIXTURE_FOLDERS.map((folder) => [`evals/demo/${folder}/case/README.md`, brokenReadme]),
    ),
  );

  const result = runVerifyDocs(root);
  assert.equal(result.status, 0, result.stderr);
});

test("verify-docs still checks eval docs outside the listed folders", (t) => {
  const root = repository(t, {
    "evals/demo/README.md": brokenReadme,
    "evals/demo/setup/case/README.md": brokenReadme,
    "evals/demo/overlays/case/README.md": brokenReadme,
  });

  const result = runVerifyDocs(root);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.stderr.trim().split("\n").toSorted(), [
    "evals/demo/README.md: broken local link docs/design.md",
    "evals/demo/overlays/case/README.md: broken local link docs/design.md",
    "evals/demo/setup/case/README.md: broken local link docs/design.md",
  ]);
});
