#!/usr/bin/env node

import {
  DefaultResourceLoader,
  SettingsManager,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

const ONLY_NON_EXECUTABLE_REGULAR_FILE_MODE = "100644";

const OWNER_EXECUTE_BIT = 0o100;

interface IndexEntry {
  readonly mode: string;
  readonly path: string;
}

const index: IndexEntry[] = [];

for (const record of execFileSync("git", ["ls-files", "--stage", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0")) {
  const match = record.match(/^(\d+) [0-9a-f]+ \d\t(.+)$/s);

  if (match) index.push({ mode: match[1], path: match[2] });
}

function startsWithShebang(path: string) {
  const descriptor = openSync(resolve(root, path), "r");
  const head = Buffer.alloc(2);

  try {
    readSync(descriptor, head, 0, 2, 0);
  } finally {
    closeSync(descriptor);
  }

  return head.toString("latin1") === "#!";
}

function shebangScriptErrors(entries: readonly IndexEntry[]) {
  const errors: string[] = [];

  for (const { mode, path } of entries) {
    const workingTree = lstatSync(resolve(root, path), { throwIfNoEntry: false });

    if (!workingTree?.isFile() || !startsWithShebang(path)) continue;

    const indexExecutable = mode !== ONLY_NON_EXECUTABLE_REGULAR_FILE_MODE;
    const workingTreeExecutable = (workingTree.mode & OWNER_EXECUTE_BIT) !== 0;

    if (indexExecutable && workingTreeExecutable) continue;

    const workingTreeMode = (workingTree.mode & 0o777).toString(8).padStart(4, "0");

    errors.push(
      `${path}: starts with #! but is not executable (git index mode ${mode}, working tree mode ${workingTreeMode}). Run: chmod +x ${path} && git add ${path}`,
    );
  }

  return errors;
}

const SKILL_TREES = "agent/skills, .agents/skills";

function isInCheckout(path: string) {
  const fromRoot = relative(root, path);

  return !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

function diagnosticError({ message, path, collision }: ResourceDiagnostic) {
  const location = path === undefined ? SKILL_TREES : relative(root, path);

  if (collision === undefined) return `${location}: ${message}`;

  return `${location}: ${message}. Pi drops this file and keeps ${relative(root, collision.winnerPath)}`;
}

function nameDirectoryMismatches(skills: readonly Skill[]) {
  return skills.flatMap(({ name, filePath }) => {
    const directoryName = basename(dirname(filePath));

    if (name === directoryName) return [];

    return [
      `${relative(root, filePath)}: name "${name}" does not match its directory "${directoryName}"`,
    ];
  });
}

const settingsIgnoringUntrackedMachineSettings = SettingsManager.inMemory(
  {},
  { projectTrusted: true },
);

// A session in this checkout discovers agent/skills as the agent directory's skills and
// .agents/skills as a trusted project's skills, each with its own layout rules.
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir: join(root, "agent"),
  settingsManager: settingsIgnoringUntrackedMachineSettings,
  noExtensions: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});

await loader.reload();

// The loader also reads ~/.agents/skills. Pi loads it last, so it never displaces a checkout
// skill, and dropping it here keeps every machine and CI on the same result.
const session = loader.getSkills();

const skills = session.skills.filter(({ filePath }) => isInCheckout(filePath));

const diagnostics = session.diagnostics.filter(
  ({ path }) => path === undefined || isInCheckout(path),
);

const POTETO_SCRIPTS = "agent/poteto/scripts/";

const scriptDirectories = [
  ...skills.map(({ baseDir }) => `${relative(root, baseDir)}/scripts/`),
  POTETO_SCRIPTS,
];

const checkedScripts = index.filter(({ path }) =>
  scriptDirectories.some((directory) => path.startsWith(directory)),
);

const errors = [
  ...shebangScriptErrors(checkedScripts),
  ...diagnostics.map(diagnosticError),
  ...nameDirectoryMismatches(skills),
];

if (skills.length === 0) {
  errors.push(`${SKILL_TREES}: Pi loaded no skill from either tree`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Skills verified (${skills.length} skills, ${checkedScripts.length} script files).`);
}
