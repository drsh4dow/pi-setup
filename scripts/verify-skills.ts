#!/usr/bin/env node

import {
  DefaultResourceLoader,
  parseFrontmatter,
  SettingsManager,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { isEvalFixturePath } from "./eval-fixture-folders.ts";

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

// Each skill in agent/skills states who can start it, so a reader of its SKILL.md needs neither
// Pi's default for disable-model-invocation nor skill-visibility's for user-invokable.
const INVOCATION_FLAGS = ["disable-model-invocation", "user-invokable"] as const;

function missingInvocationFlags(skills: readonly Skill[]) {
  const agentSkills = `${join(root, "agent", "skills")}/`;

  return skills
    .filter(({ filePath }) => filePath.startsWith(agentSkills))
    .flatMap(({ filePath }) => {
      const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf8"));

      return INVOCATION_FLAGS.flatMap((flag) =>
        frontmatter[flag] === true || frontmatter[flag] === false
          ? []
          : [`${relative(root, filePath)}: set "${flag}" to true or false`],
      );
    });
}

// The forms one document uses to send the agent to a skill: "the **how** skill", "the **a** and
// **b** principle skills" (a principle skill's name carries the `principle-` prefix),
// "**principle-x**", "/skill:name", and a path such as the router's
// `~/.pi/agent/skills/name/SKILL.md`. A bold term with no leading "the", such as "a
// **model-invoked** skill", names a kind of skill. A quoted `'/skill:pre'` is a keystroke
// string, such as an autocomplete prefix.
const BOLD_SKILL_SERIES =
  /\bthe ((?:\*\*[a-z0-9-]+\*\*(?:,? (?:and|or) |, ))*\*\*[a-z0-9-]+\*\*) (principle )?skills?\b/g;

const BOLD_NAME = /\*\*([a-z0-9-]+)\*\*/g;

const BOLD_PRINCIPLE = /\*\*(principle-[a-z0-9-]+)\*\*/g;

const SLASH_COMMAND = /(?<!')\/skill:([a-z0-9-]+)(?![a-z0-9-]*')/g;

const SKILL_PATH = /skills\/([a-z0-9-]+)\/SKILL\.md/g;

function pointedSkills(line: string) {
  const names = new Set<string>();

  for (const [, series, principle] of line.matchAll(BOLD_SKILL_SERIES)) {
    for (const [, name] of series.matchAll(BOLD_NAME)) {
      names.add(principle && !name.startsWith("principle-") ? `principle-${name}` : name);
    }
  }

  for (const [, name] of line.matchAll(BOLD_PRINCIPLE)) names.add(name);

  for (const [, name] of line.matchAll(SLASH_COMMAND)) names.add(name);

  for (const [, name] of line.matchAll(SKILL_PATH)) names.add(name);

  return names;
}

interface SkillPointer {
  readonly path: string;
  readonly line: number;
  readonly name: string;
}

const markdown = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter((path) => path !== "" && !isEvalFixturePath(path))
  .filter((path) => lstatSync(resolve(root, path), { throwIfNoEntry: false }));

const skillPointers: SkillPointer[] = markdown.flatMap((path) =>
  readFileSync(resolve(root, path), "utf8")
    .split("\n")
    .flatMap((line, lineIndex) =>
      [...pointedSkills(line)].map((name) => ({ path, line: lineIndex + 1, name })),
    ),
);

function danglingSkillPointers(loaded: readonly Skill[]) {
  const names = new Set(loaded.map(({ name }) => name));

  return skillPointers.flatMap(({ path, line, name }) =>
    names.has(name) ? [] : [`${path}:${line}: points to skill "${name}", which Pi does not load`],
  );
}

// A skill hidden from the model's table is a library skill: the model reaches it only through a
// pointer in the router or another mode prompt, a role prompt, a prompt template, or another skill.
function pointsIntoTheHarness(path: string, skillDirectories: readonly string[]) {
  return (
    path === "agent/SYSTEM.md" ||
    path.startsWith("agent/system/") ||
    path.startsWith("agent/prompts/") ||
    skillDirectories.some((directory) => path.startsWith(directory))
  );
}

function unreachableHiddenSkills(loaded: readonly Skill[]) {
  const skillDirectories = loaded.map(({ baseDir }) => `${relative(root, baseDir)}/`);

  return loaded.flatMap(({ name, baseDir, filePath, disableModelInvocation }) => {
    if (!disableModelInvocation) return [];

    const ownDirectory = `${relative(root, baseDir)}/`;

    const reached = skillPointers.some(
      (pointer) =>
        pointer.name === name &&
        !pointer.path.startsWith(ownDirectory) &&
        pointsIntoTheHarness(pointer.path, skillDirectories),
    );

    if (reached) return [];

    return [
      `${relative(root, filePath)}: hidden from the model (disable-model-invocation: true), and no router entry, skill, role prompt, or mode prompt points to it`,
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

const scriptDirectories = skills.map(({ baseDir }) => `${relative(root, baseDir)}/scripts/`);

const checkedScripts = index.filter(({ path }) =>
  scriptDirectories.some((directory) => path.startsWith(directory)),
);

const errors = [
  ...shebangScriptErrors(checkedScripts),
  ...diagnostics.map(diagnosticError),
  ...nameDirectoryMismatches(skills),
  ...missingInvocationFlags(skills),
  ...danglingSkillPointers(skills),
  ...unreachableHiddenSkills(skills),
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
