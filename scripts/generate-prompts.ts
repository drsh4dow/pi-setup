// `node scripts/generate-prompts.ts` builds every system prompt from the parts in
// agent/system/, and `--check` writes nothing and prints one line per problem, such as a prompt
// on disk that differs from its build. A prompt is agent/system/core.md with each slot line replaced by
// that slot's sections from the prompt's parts, so every mode and role prompt shares one core.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SLOTS = ["workflow", "conduct"] as const;

type Slot = (typeof SLOTS)[number];

const SLOT_LINE = /^<!-- slot: (\S+) -->$/u;

function isSlot(name: string): name is Slot {
  return SLOTS.some((slot) => slot === name);
}

// Thrown for a core or a part that cannot be composed. `source` is the index of the part in
// the list composePrompt was given, or "core".
export class PromptSourceError extends Error {
  readonly source: number | "core";

  constructor(source: number | "core", message: string) {
    super(message);
    this.source = source;
  }
}

function withoutBlankEdges(lines: readonly string[]) {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start].trim() === "") start += 1;

  while (end > start && lines[end - 1].trim() === "") end -= 1;

  return lines.slice(start, end).join("\n");
}

function slotOf(line: string, source: number | "core"): Slot | null {
  const match = SLOT_LINE.exec(line);

  if (match === null) return null;

  const [, name] = match;

  if (!isSlot(name)) {
    throw new PromptSourceError(source, `names slot "${name}"; the slots are ${SLOTS.join(", ")}`);
  }

  return name;
}

// A part is one or more sections, each opened by a slot line. A section's text is the lines
// up to the next slot line, without the blank lines at its edges.
function partSections(part: string, index: number) {
  const sections: { readonly slot: Slot; readonly text: string }[] = [];
  let slot: Slot | null = null;
  let lines: string[] = [];

  const close = () => {
    const text = withoutBlankEdges(lines);

    if (slot !== null && text !== "") sections.push({ slot, text });
  };

  for (const line of part.split("\n")) {
    const opened = slotOf(line, index);

    if (opened !== null) {
      close();
      slot = opened;
      lines = [];
      continue;
    }

    if (slot === null && line.trim() !== "") {
      throw new PromptSourceError(index, "has text before its first slot line");
    }

    lines.push(line);
  }

  close();

  return sections;
}

// Each slot line becomes the slot's sections in part order, separated by one blank line. A
// slot that no part fills is removed with the blank line after it.
export function composePrompt(core: string, parts: readonly string[]): string {
  const sections = parts.flatMap((part, index) => partSections(part, index));
  const coreLines = core.split("\n");
  const prompt: string[] = [];

  for (const slot of SLOTS) {
    const count = coreLines.filter((line) => slotOf(line, "core") === slot).length;

    if (count !== 1) {
      throw new PromptSourceError("core", `holds the ${slot} slot line ${count} times, not once`);
    }
  }

  for (let index = 0; index < coreLines.length; index += 1) {
    const line = coreLines[index];
    const slot = slotOf(line, "core");

    if (slot === null) {
      prompt.push(line);
      continue;
    }

    const filling = sections.filter((section) => section.slot === slot);

    if (filling.length > 0) {
      prompt.push(filling.map((section) => section.text).join("\n\n"));
    } else if (coreLines[index + 1]?.trim() === "") {
      index += 1;
    }
  }

  return prompt.join("\n");
}

// One prompt to build: its output and its parts, in order, as repository-relative paths. The
// core is part of every build and so is not listed.
export interface PromptBuild {
  readonly output: string;
  readonly parts: readonly string[];
}

const CORE = "agent/system/core.md";

const GENERATED = "agent/system/generated";

const KINDS = ["delegate", "owner"] as const;

function markdownFiles(directory: string) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .toSorted();
}

// Builds are found by convention, so a new mode or role adds files and never edits this
// script: general always, sh4dow when its part exists, and one prompt per role part, whose
// directory is its kind.
export function promptPlan(root: string): readonly PromptBuild[] {
  const plan: PromptBuild[] = [{ output: "agent/SYSTEM.md", parts: ["agent/system/general.md"] }];

  if (existsSync(join(root, "agent/system/sh4dow.md"))) {
    plan.push({ output: `${GENERATED}/sh4dow.md`, parts: ["agent/system/sh4dow.md"] });
  }

  for (const kind of KINDS) {
    for (const role of markdownFiles(join(root, "agent/system/roles", kind))) {
      plan.push({
        output: `${GENERATED}/${kind}/${role}`,
        parts: [
          "agent/system/subagent.md",
          `agent/system/kinds/${kind}.md`,
          `agent/system/roles/${kind}/${role}`,
        ],
      });
    }
  }

  return plan;
}

type Built =
  | { readonly kind: "built"; readonly text: string }
  | { readonly kind: "failed"; readonly problem: string };

function build(root: string, prompt: PromptBuild): Built {
  const sources = [CORE, ...prompt.parts];
  const absent = sources.find((source) => !existsSync(join(root, source)));

  if (absent !== undefined) {
    return { kind: "failed", problem: `${prompt.output}: cannot build, ${absent} is missing` };
  }

  const [core, ...parts] = sources.map((source) => readFileSync(join(root, source), "utf8"));

  try {
    return { kind: "built", text: composePrompt(core, parts) };
  } catch (error) {
    if (!(error instanceof PromptSourceError)) throw error;

    const source = error.source === "core" ? CORE : prompt.parts[error.source];

    return { kind: "failed", problem: `${source}: ${error.message}` };
  }
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

// The problems that `--check` prints, one line each: a prompt on disk that differs from its
// build or is missing, a part that cannot be composed, and a generated file no build produces.
export function checkPrompts(root: string): readonly string[] {
  const plan = promptPlan(root);
  const problems = new Set<string>();

  for (const prompt of plan) {
    const built = build(root, prompt);

    if (built.kind === "failed") {
      problems.add(built.problem);
      continue;
    }

    const path = join(root, prompt.output);

    if (!existsSync(path)) {
      problems.add(`${prompt.output}: missing; run vp run generate:prompts`);
    } else if (readFileSync(path, "utf8") !== built.text) {
      problems.add(
        `${prompt.output}: differs from what scripts/generate-prompts.ts builds from ${[CORE, ...prompt.parts].join(", ")}. Edit those parts, then run vp run generate:prompts.`,
      );
    }
  }

  const outputs = new Set(plan.map((prompt) => prompt.output));

  for (const path of filesUnder(join(root, GENERATED))) {
    const file = relative(root, path);

    if (!outputs.has(file))
      problems.add(`${file}: no part builds this file; delete it or restore its part`);
  }

  return [...problems];
}

function writePrompts(root: string) {
  for (const prompt of promptPlan(root)) {
    const built = build(root, prompt);

    if (built.kind === "failed") continue;

    const path = join(root, prompt.output);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, built.text);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("usage: node scripts/generate-prompts.ts [--check]");

    return 2;
  }

  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  if (args.length === 0) writePrompts(root);

  // After a write, only the problems a write cannot fix remain.
  const problems = checkPrompts(root);

  for (const problem of problems) console.error(problem);

  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main();
