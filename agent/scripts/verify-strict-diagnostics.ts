import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const fixture = mkdtempSync(join(tmpdir(), "pi-strict-diagnostics-"));

function run(args: string[]) {
  const result = spawnSync("vp", args, { cwd: fixture, encoding: "utf8", timeout: 30_000 });

  if (result.error) throw result.error;
  assert.equal(result.signal, null, `vp ${args.join(" ")} terminated by signal`);
  assert.notEqual(result.status, null);

  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function requireClean(args: string[]) {
  const result = run(args);
  assert.equal(result.status, 0, result.output);
}

function requireDiagnostic(path: string, source: string, expected: RegExp, format = true) {
  const destination = join(fixture, path);
  writeFileSync(destination, source);

  try {
    if (format) requireClean(["fmt", path]);
    const result = run(["check"]);
    assert.notEqual(result.status, 0, `${path} unexpectedly passed vp check`);
    assert.match(result.output, expected, result.output);
    console.log(`${path}: rejected with ${expected.source}`);
  } finally {
    rmSync(destination);
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

  for (const directory of sourceDirectories) {
    mkdirSync(join(fixture, directory), { recursive: true });
    writeFileSync(join(fixture, directory, "clean.ts"), "export const clean = true;\n");
  }

  requireClean(["check"]);

  // A missing project or an over-broad ignore must not silently drop owned code.
  for (const directory of sourceDirectories) {
    requireDiagnostic(`${directory}/type-error.ts`, "export const value: string = 1;\n", /TS2322/);
  }

  requireDiagnostic(
    "agent/extensions/format.ts",
    "export const value=1;\n",
    /format|Format/,
    false,
  );
  requireDiagnostic(
    "agent/extensions/effect.ts",
    'import { Effect } from "effect";\nexport const result = Effect.all([1, 2].map(Effect.succeed));\n',
    /all-of-map-to-for-each/,
  );
  requireDiagnostic(
    "agent/extensions/typed-lint.ts",
    "export function unsafe(value: any): string { return value; }\n",
    /no-unsafe-return/,
  );
  requireDiagnostic(
    "agent/extensions/anti-slop.ts",
    'export const value = Reflect.get({ name: "example" }, "name");\n',
    /no-reflect-get/,
  );
  requireDiagnostic(
    "agent/extensions/warning.ts",
    "export const now = new Date();\n",
    /global-date/,
  );
  requireDiagnostic(
    "agent/extensions/too-long.ts",
    `${"// line\n".repeat(601)}export const value = true;\n`,
    /max-lines/,
  );
  requireClean(["check"]);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
