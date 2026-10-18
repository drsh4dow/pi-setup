#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

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

function isSkillScript(path: string) {
  return /^(agent|\.agents)\/skills\/[^/]+\/scripts\//.test(path);
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

function skillScriptErrors(entries: readonly IndexEntry[]) {
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

const skillScripts = index.filter(({ path }) => isSkillScript(path));

const errors = skillScriptErrors(skillScripts);

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Skills verified (${skillScripts.length} script files).`);
}
