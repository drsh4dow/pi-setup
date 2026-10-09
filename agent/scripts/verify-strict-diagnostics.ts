import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const fixture = mkdtempSync(join(tmpdir(), "pi-strict-diagnostics-"));

function check() {
  const result = spawnSync("vp", ["check"], { cwd: fixture, encoding: "utf8", timeout: 30_000 });

  if (result.error) throw result.error;
  assert.equal(result.signal, null, "vp check terminated by signal");
  assert.notEqual(result.status, null);

  // Vite+ tasks set FORCE_COLOR, which styles the diagnostics this script matches.
  return {
    status: result.status,
    output: stripVTControlCharacters(`${result.stdout}${result.stderr}`),
  };
}

interface Violation {
  path: string;
  source: string;
  diagnostic: string;
}

// One vp check rejects every violation in the batch. Each diagnostic is attributed to
// its file, so a single run proves each violation independently. vp check prints a
// header line such as `x eslint(max-lines): ...` followed by a source frame that
// opens with `[path:line:column]`.
function requireRejected(violations: Violation[]) {
  for (const { path, source } of violations) writeFileSync(join(fixture, path), source);

  try {
    const result = check();
    assert.notEqual(result.status, 0, `vp check unexpectedly passed\n${result.output}`);
    const lines = result.output.split("\n");

    for (const { path, diagnostic } of violations) {
      assert.ok(
        lines.some(
          (line, index) =>
            line.includes(`(${diagnostic}):`) && lines[index + 1]?.includes(`[${path}:`),
        ),
        `${path} was not rejected with ${diagnostic}\n${result.output}`,
      );
      console.log(`${path}: rejected with ${diagnostic}`);
    }
  } finally {
    for (const { path } of violations) rmSync(join(fixture, path));
  }
}

try {
  // Oxlint honors repository ignore files during discovery, including node_modules.
  execFileSync("git", ["init", "--quiet", fixture]);

  for (const path of ["node_modules", "tools"])
    symlinkSync(join(repository, path), join(fixture, path), "dir");

  for (const path of [
    ".gitignore",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "cli/dumpfile/tsconfig.json",
  ]) {
    const destination = join(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repository, path), destination);
  }

  const sourceDirectories = [
    "agent/extensions",
    "agent/lib",
    "agent/scripts",
    "agent/skills/babysit-pr/scripts",
    "cli/dumpfile/src",
  ];

  for (const directory of sourceDirectories)
    mkdirSync(join(fixture, directory), { recursive: true });

  const formatPath = "agent/extensions/format.ts";
  writeFileSync(join(fixture, formatPath), "export const value=1;\n");

  try {
    // Formatting failures stop vp check before lint, so this violation runs alone.
    const result = check();
    assert.notEqual(result.status, 0, `${formatPath} unexpectedly passed vp check`);
    assert.match(result.output, /Formatting issues found/, result.output);
    assert.ok(
      result.output.split("\n").some((line) => line.startsWith(`${formatPath} (`)),
      result.output,
    );
    console.log(`${formatPath}: rejected with Formatting issues found`);
  } finally {
    rmSync(join(fixture, formatPath));
  }

  // Alone, a rejected warning proves that warnings fail the check.
  requireRejected([
    {
      path: "agent/extensions/warning.ts",
      source: "export const now = new Date();\n",
      diagnostic: "global-date",
    },
  ]);

  // A missing project or an over-broad ignore must not silently drop owned code.
  const typeErrors = sourceDirectories.map((directory) => ({
    path: `${directory}/type-error.ts`,
    source: "export const value: string = 1;\n",
    diagnostic: "TS2322",
  }));

  requireRejected([
    ...typeErrors,
    {
      path: "agent/extensions/effect.ts",
      source:
        'import { Effect } from "effect";\n\nexport const result = Effect.all([1, 2].map(Effect.succeed));\n',
      diagnostic: "all-of-map-to-for-each",
    },
    {
      path: "agent/extensions/typed-lint.ts",
      source: "export function unsafe(value: any): string {\n  return value;\n}\n",
      diagnostic: "no-unsafe-return",
    },
    {
      path: "agent/extensions/anti-slop.ts",
      source: 'export const value = Reflect.get({ name: "example" }, "name");\n',
      diagnostic: "no-reflect-get",
    },
    {
      path: "agent/extensions/too-long.ts",
      source: `${"// line\n".repeat(601)}export const value = true;\n`,
      diagnostic: "max-lines",
    },
  ]);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
