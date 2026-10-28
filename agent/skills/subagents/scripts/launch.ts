#!/usr/bin/env node
// Launch one subagent from a brief file, or refuse. It checks the brief, holds while the host
// is saturated, then runs pi-subagent on the role's generated prompt, with skill discovery off,
// one --skill per name in the brief's SKILLS field, each of those skills' SKILL.md appended, and
// the standing orders appended. Pi reads the prompt and every append at process start, so a
// spawn and a resume both see the skills and the orders as they stand. The child's report goes to stdout; launcher lines go to stderr.
//
// Exit codes: 0 the child reported (or the dry run passed), 1 the child failed, 2 refused or
// could not run, with no Pi process started.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import {
  briefProblems,
  briefSkills,
  inputBranches,
  KINDS,
  ROLES,
  type Kind,
  type Problem,
  type Role,
} from "./brief.ts";

const AGENT_DIRECTORY = resolve(import.meta.dirname, "../../..");

const HARNESS_SKILLS = join(AGENT_DIRECTORY, "skills");

const ROLE_PROMPTS = join(AGENT_DIRECTORY, "system", "generated");

const USAGE = `usage: launch.ts --kind <delegate|owner> --role <role> --brief <file> --orders <file|none>
                 --model <model> --thinking <level> --name <short assignment>
                 [--append <file>]... [--resume <session>] [--dry-run]
                 [--max-load <n>] [--min-mem-gib <n>] [--poll-seconds <n>]
roles: ${ROLES.join(", ")}`;

class Refusal {
  readonly reasons: readonly string[];
  readonly showUsage: boolean;

  constructor(reasons: readonly string[], showUsage = false) {
    this.reasons = reasons;
    this.showUsage = showUsage;
  }
}

class UsageError extends Refusal {
  constructor(reason: string) {
    super([reason], true);
  }
}

interface Options {
  readonly kind: Kind;
  readonly role: Role;
  readonly brief: string;
  readonly orders: string | null;
  readonly model: string;
  readonly thinking: string;
  readonly name: string;
  readonly appends: readonly string[];
  readonly resume: string | null;
  readonly dryRun: boolean;
  readonly maxLoad: number;
  readonly minMemGib: number;
  readonly pollSeconds: number;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") throw new UsageError(`${flag} is required`);

  return value;
}

function positive(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new UsageError(`${flag} must be a positive number, got ${value}`);

  return parsed;
}

function parseOptions(argv: readonly string[]): Options {
  let values;

  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        kind: { type: "string" },
        role: { type: "string" },
        brief: { type: "string" },
        orders: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string" },
        name: { type: "string" },
        append: { type: "string", multiple: true, default: [] },
        resume: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "max-load": { type: "string" },
        "min-mem-gib": { type: "string" },
        "poll-seconds": { type: "string" },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const kindValue = required(values.kind, "--kind");
  const kind = KINDS.find((candidate) => candidate === kindValue);

  if (kind === undefined) throw new UsageError(`--kind must be delegate or owner, got ${kindValue}`);

  const roleValue = required(values.role, "--role");
  const role = ROLES.find((candidate) => candidate === roleValue);

  if (role === undefined) throw new UsageError(`--role must be one of ${ROLES.join(", ")}`);

  const orders = required(values.orders, "--orders");

  return {
    kind,
    role,
    brief: required(values.brief, "--brief"),
    orders: orders === "none" ? null : resolve(orders),
    model: required(values.model, "--model"),
    thinking: required(values.thinking, "--thinking"),
    name: required(values.name, "--name"),
    appends: values.append.map((path) => resolve(path)),
    resume: values.resume ?? null,
    dryRun: values["dry-run"],
    maxLoad: positive(values["max-load"], "--max-load", availableParallelism()),
    minMemGib: positive(values["min-mem-gib"], "--min-mem-gib", 4),
    pollSeconds: positive(values["poll-seconds"], "--poll-seconds", 30),
  };
}

// Pi appends a path it cannot read as literal text, so every append must be a real file with
// content before it reaches the command line.
function readFilled(path: string, what: string): string {
  if (!existsSync(path)) throw new Refusal([`${what} ${path} does not exist`]);

  if (!statSync(path).isFile()) throw new Refusal([`${what} ${path} is not a file`]);

  const text = readFileSync(path, "utf8");

  if (text.trim() === "") throw new Refusal([`${what} ${path} is empty`]);

  return text;
}

// A role's kind is the directory its generated prompt sits in, so --kind must agree with it.
function rolePrompt(options: Options): string {
  const kind = KINDS.find((candidate) => existsSync(join(ROLE_PROMPTS, candidate, `${options.role}.md`)));

  if (kind === undefined)
    throw new Refusal([
      `role ${options.role} has no prompt under ${ROLE_PROMPTS}; run vp run generate:prompts in the harness checkout`,
    ]);

  if (kind !== options.kind)
    throw new Refusal([`role ${options.role} runs as ${kind}, but the launch is --kind ${options.kind}`]);

  return join(ROLE_PROMPTS, kind, `${options.role}.md`);
}

interface Skill {
  readonly name: string;
  readonly directory: string;
}

// Each name resolves to the harness's skill first, then to the launch directory's project skill.
function resolveSkills(brief: string, names: readonly string[]): Skill[] {
  const roots = [HARNESS_SKILLS, join(process.cwd(), ".agents", "skills")];
  const skills = names.map((name) => ({
    name,
    directory: roots.map((root) => join(root, name)).find((dir) => existsSync(join(dir, "SKILL.md"))),
  }));
  const unknown = skills.flatMap(({ name, directory }) => (directory === undefined ? [name] : []));

  if (unknown.length > 0)
    throw new Refusal(
      unknown.map((name) => `${brief}: SKILLS names ${name}, which is no skill in ${roots.join(" or ")}`),
    );

  return skills.flatMap(({ name, directory }) => (directory === undefined ? [] : [{ name, directory }]));
}

function problemLine(brief: string, problem: Problem): string {
  return problem.line === null
    ? `${brief}: ${problem.message}`
    : `${brief}:${problem.line}: ${problem.message}`;
}

function missingBranches(branches: readonly string[]): string[] {
  if (branches.length === 0) return [];

  const result = spawnSync("git", ["ls-remote", "--heads", "origin"], { encoding: "utf8" });

  if (result.error !== undefined || result.status !== 0)
    throw new Refusal([
      `could not list origin's branches from ${process.cwd()}: ${(result.stderr || String(result.error)).trim()}`,
    ]);

  const heads = new Set(
    result.stdout.split("\n").flatMap((line) => {
      const ref = line.split("\t")[1];

      return ref?.startsWith("refs/heads/") === true ? [ref.slice("refs/heads/".length)] : [];
    }),
  );

  return branches.filter((branch) => !heads.has(branch));
}

interface HostLoad {
  readonly load: number;
  readonly memAvailableGib: number;
}

// The /proc paths are overridable so a test can inject a saturated host.
function readHostLoad(): HostLoad {
  const loadPath = process.env.PI_LAUNCH_LOADAVG ?? "/proc/loadavg";
  const memPath = process.env.PI_LAUNCH_MEMINFO ?? "/proc/meminfo";

  try {
    // An empty or blank file has no first token, and Number(undefined) is NaN, so the launcher
    // refuses it instead of reading load 0.
    const load = Number(/^(\S+)/.exec(readFileSync(loadPath, "utf8"))?.[1]);
    const kib = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync(memPath, "utf8"))?.[1]);

    if (Number.isFinite(load) && Number.isFinite(kib))
      return { load, memAvailableGib: kib / 1024 / 1024 };
  } catch (error) {
    throw new Refusal([`could not read host load: ${String(error)}`]);
  }

  throw new Refusal([`could not parse the load in ${loadPath} or MemAvailable in ${memPath}`]);
}

function describeLoad(host: HostLoad, options: Options): string {
  return `load ${host.load.toFixed(2)} (max ${options.maxLoad}), MemAvailable ${host.memAvailableGib.toFixed(1)} GiB (min ${options.minMemGib} GiB)`;
}

async function admit(options: Options): Promise<void> {
  for (;;) {
    const host = readHostLoad();

    if (host.load <= options.maxLoad && host.memAvailableGib >= options.minMemGib) {
      process.stderr.write(`launch: admitted: ${describeLoad(host, options)}\n`);

      return;
    }

    process.stderr.write(
      `launch: holding, host saturated: ${describeLoad(host, options)}; next check in ${options.pollSeconds}s\n`,
    );
    await delay(options.pollSeconds * 1000);
  }
}

function lineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

type Append =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "orders"; readonly path: string }
  | { readonly kind: "skill"; readonly name: string; readonly path: string }
  | { readonly kind: "text"; readonly text: string };

interface Launch {
  readonly argv: readonly string[];
  readonly systemPrompt: string;
  readonly skills: readonly Skill[];
  readonly appends: readonly Append[];
  readonly session: string;
  readonly prompt: string;
}

// Pi sends a resumed session's rebuilt system prompt as a system update after the earlier
// text, and a model can distrust that update as an injected addendum. The note says which is
// current, in the user turn the child trusts.
function resumeNote(orders: string): string {
  return `Your system prompt was rebuilt for this resume. A system update to its addendum in this turn holds the current standing orders from ${orders}. Where it differs from the earlier text, the update is current and binds you.\n\n`;
}

// Pi joins the appends with no label, so a literal heading tells the child which text is the
// orders. The orders themselves stay a path, which Pi reads when the child starts.
function ordersHeading(path: string): string {
  return `# Standing orders\n\nThe next appended text is ${path}, the standing orders of the run that launched you, as the file stood when this process started. Each line binds your assignment unless your brief lifts it by number.`;
}

// Pi leaves a skill with `disable-model-invocation: true` out of the skill table even when
// --skill loads it, so each named skill's SKILL.md travels as an append, labelled like the orders.
function skillAppends({ name, directory }: Skill): Append[] {
  const path = join(directory, "SKILL.md");

  return [
    {
      kind: "text",
      text: `# Skill: ${name}\n\nThe next appended text is ${path}, the ${name} skill your assignment's SKILLS field names, in full. Follow it, and resolve the relative paths in it against ${directory}.`,
    },
    { kind: "skill", name, path },
  ];
}

function appendArgument(append: Append): string {
  return append.kind === "text" ? append.text : append.path;
}

interface LaunchInput {
  readonly options: Options;
  readonly brief: string;
  readonly systemPrompt: string;
  readonly skills: readonly Skill[];
}

function launchArguments({ options, brief, systemPrompt, skills }: LaunchInput): Launch {
  const file = (path: string): Append => ({ kind: "file", path });
  const orders: Append[] =
    options.orders === null
      ? []
      : [
          { kind: "text", text: ordersHeading(options.orders) },
          { kind: "orders", path: options.orders },
        ];
  const appends = [...skills.flatMap(skillAppends), ...orders, ...options.appends.map(file)];
  const session = options.resume ?? randomUUID();
  const name = options.name.startsWith("subagent: ") ? options.name : `subagent: ${options.name}`;

  return {
    systemPrompt,
    skills,
    appends,
    session,
    prompt: options.resume !== null && options.orders !== null ? resumeNote(options.orders) + brief : brief,
    argv: [
      "--model",
      options.model,
      "--thinking",
      options.thinking,
      "--system-prompt",
      systemPrompt,
      "--no-skills",
      ...skills.flatMap(({ directory }) => ["--skill", directory]),
      ...appends.flatMap((append) => ["--append-system-prompt", appendArgument(append)]),
      "--name",
      name,
      options.resume === null ? "--session-id" : "--session",
      session,
    ],
  };
}

function shellQuote(word: string): string {
  return /^[\w./:=@-]+$/.test(word) ? word : `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

function printDryRun(launch: Launch, options: Options): void {
  const out: string[] = [
    "launch: dry run, no Pi process started",
    `command: pi-subagent ${launch.argv.map(shellQuote).join(" ")}`,
    `session: ${launch.session}${options.resume === null ? " (new)" : " (resumed)"}`,
    `--- system prompt: ${launch.systemPrompt} ---`,
    readFileSync(launch.systemPrompt, "utf8").trimEnd(),
    "--- skills ---",
    ...(launch.skills.length === 0
      ? ["none"]
      : launch.skills.map(({ name, directory }) => `${name}\t${directory}`)),
  ];

  for (const append of launch.appends) {
    switch (append.kind) {
      case "text":
        out.push("--- system prompt append: literal text ---", append.text);
        break;
      case "skill":
        out.push(
          `--- system prompt append: ${append.path} (skill ${append.name}) ---`,
          readFileSync(append.path, "utf8").trimEnd(),
        );
        break;
      case "file":
        out.push(
          `--- system prompt append: ${append.path} ---`,
          readFileSync(append.path, "utf8").trimEnd(),
        );
        break;
      case "orders": {
        const text = readFileSync(append.path, "utf8");

        out.push(
          `--- system prompt append: ${append.path} (standing orders, ${lineCount(text)} lines) ---`,
          text.trimEnd(),
        );
        break;
      }
      default: {
        const unexpected: never = append;
        throw new Error(`Unexpected append: ${String(unexpected)}`);
      }
    }
  }

  out.push("--- prompt (stdin) ---", launch.prompt.trimEnd(), "");
  process.stdout.write(out.join("\n"));
}

type ChildEnd =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signalled"; readonly signal: string }
  | { readonly kind: "unstarted"; readonly message: string };

async function runChild(launch: Launch): Promise<number> {
  const child = spawn("pi-subagent", [...launch.argv], { stdio: ["pipe", "inherit", "inherit"] });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward(signal));

  // A child that exits before reading its prompt closes the pipe; its exit status reports that.
  child.stdin.on("error", () => undefined);
  child.stdin.end(launch.prompt);

  const end = await new Promise<ChildEnd>((done) => {
    child.on("error", (error) => done({ kind: "unstarted", message: error.message }));
    child.on("close", (code, signal) =>
      done(code === null ? { kind: "signalled", signal: signal ?? "unknown" } : { kind: "exited", code }),
    );
  });

  switch (end.kind) {
    case "exited":
      if (end.code === 0) return 0;
      process.stderr.write(`launch: pi-subagent exited with ${end.code}\n`);

      return 1;
    case "signalled":
      process.stderr.write(`launch: pi-subagent was killed by ${end.signal}\n`);

      return 1;
    case "unstarted":
      process.stderr.write(`launch: could not run pi-subagent: ${end.message}\n`);

      return 2;
    default: {
      const unexpected: never = end;
      throw new Error(`Unexpected child end: ${String(unexpected)}`);
    }
  }
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseOptions(argv);
    const systemPrompt = rolePrompt(options);
    const brief = readFilled(options.brief, "brief");

    if (options.orders !== null) readFilled(options.orders, "orders file");

    for (const path of options.appends) readFilled(path, "append file");

    const problems = briefProblems({
      text: brief,
      role: options.role,
      kind: options.kind,
      resume: options.resume !== null,
    });

    if (problems.length > 0)
      throw new Refusal(problems.map((problem) => problemLine(options.brief, problem)));

    const skills = resolveSkills(options.brief, briefSkills(brief));
    const missing = missingBranches(inputBranches(brief));

    if (missing.length > 0)
      throw new Refusal(
        missing.map((branch) => `${options.brief}: origin has no branch ${branch}`),
      );

    await admit(options);

    // Read the orders again: they may have grown while the launch was held.
    if (options.orders !== null) {
      const orders = readFilled(options.orders, "orders file");

      process.stderr.write(`launch: standing orders ${options.orders}, ${lineCount(orders)} lines\n`);
    }

    const launch = launchArguments({ options, brief, systemPrompt, skills });

    if (options.dryRun) {
      printDryRun(launch, options);

      return 0;
    }

    process.stderr.write(`launch: session ${launch.session}\n`);

    return await runChild(launch);
  } catch (error) {
    if (!(error instanceof Refusal)) {
      process.stderr.write(`launch: could not run: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);

      return 2;
    }

    for (const reason of error.reasons) process.stderr.write(`launch: refused: ${reason}\n`);

    if (error.showUsage) process.stderr.write(`${USAGE}\n`);

    return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
