#!/usr/bin/env node
// Launch one subagent from a brief file, or refuse. It checks the brief, holds while the host
// is saturated, then runs pi-subagent on the role's generated prompt, with skill discovery off,
// one --skill per name in the brief's SKILLS field, each of those skills' SKILL.md appended, and
// the standing orders appended. Pi reads the prompt and every append at process start, so a
// spawn and a resume both see the skills and the orders as they stand. The child's report goes to stdout; launcher lines go to stderr.
//
// Each child learns its place in the subagent tree from the environment this launcher gives it,
// so a launch from inside a child reads its parent's kind and depth and refuses a spawn the tree
// does not allow. Given a state folder, the launcher registers each child in its spawns.tsv.
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
  ROLES,
  type Kind,
  type Problem,
  type Role,
} from "./brief.ts";

// This launcher sits in <agent dir>/skills/subagents/scripts, beside the harness's skills and
// above its generated role prompts.
const SKILLS_DIRECTORY = resolve(import.meta.dirname, "../..");

const ROLE_PROMPTS = resolve(SKILLS_DIRECTORY, "../system/generated");

// implement-chunk's bookkeeping CLI, which owns the spawn registry.
const CHUNK = resolve(SKILLS_DIRECTORY, "../prompts/implement-chunk/scripts/chunk.ts");

const KINDS: readonly Kind[] = ["delegate", "owner"];

// The root is depth 0, what it launches depth 1, and what an owner launches depth 2.
const MAX_DEPTH = 2;

const USAGE = `usage: launch.ts --kind <delegate|owner> --role <role> --brief <file> --orders <file|none>
                 --model <model> --thinking <level> --name <short assignment>
                 [--append <file>]... [--resume <session>] [--dry-run]
                 [--state <dir>] [--unit <units.tsv id>]
                 [--max-load <n>] [--min-mem-gib <n>] [--poll-seconds <n>]
roles: ${ROLES.join(", ")}
The state folder comes from --state, else $IMPLEMENT_CHUNK_STATE; without one, no spawn is registered.`;

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
  readonly state: string | null;
  readonly unit: string;
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
        state: { type: "string" },
        unit: { type: "string" },
        "max-load": { type: "string" },
        "min-mem-gib": { type: "string" },
        "poll-seconds": { type: "string" },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const kindValue = required(values.kind, "--kind");
  const kind = kindValue === "delegate" || kindValue === "owner" ? kindValue : undefined;

  if (kind === undefined) throw new UsageError(`--kind must be delegate or owner, got ${kindValue}`);

  const roleValue = required(values.role, "--role");
  const role = ROLES.find((candidate) => candidate === roleValue);

  if (role === undefined) throw new UsageError(`--role must be one of ${ROLES.join(", ")}`);

  const orders = required(values.orders, "--orders");
  const state = values.state ?? process.env.IMPLEMENT_CHUNK_STATE ?? "";

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
    state: state === "" ? null : resolve(state),
    unit: values.unit ?? "-",
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

// Where a process sits in the subagent tree. A process no launcher started is the root.
type TreePosition =
  | { readonly kind: "root" }
  | { readonly kind: Kind; readonly depth: number; readonly session: string };

// The launcher gives each child these variables, and reads its own parent's position from them.
function treePosition(env: NodeJS.ProcessEnv): TreePosition {
  const { PI_SUBAGENT_KIND: kind, PI_SUBAGENT_TREE_DEPTH: depth, PI_SUBAGENT_SESSION: session } = env;

  if (kind === undefined && depth === undefined && session === undefined) return { kind: "root" };

  const known = KINDS.find((candidate) => candidate === kind);
  const where = "a launcher sets PI_SUBAGENT_KIND, PI_SUBAGENT_TREE_DEPTH, and PI_SUBAGENT_SESSION together";

  if (known === undefined)
    throw new Refusal([`PI_SUBAGENT_KIND is ${JSON.stringify(kind ?? null)}, not delegate or owner; ${where}`]);

  if (depth === undefined || !/^[1-9]\d*$/.test(depth))
    throw new Refusal([`PI_SUBAGENT_TREE_DEPTH is ${JSON.stringify(depth ?? null)}, not a depth of 1 or more; ${where}`]);

  if (session === undefined || session === "")
    throw new Refusal([`PI_SUBAGENT_SESSION is ${JSON.stringify(session ?? null)}, not a session id; ${where}`]);

  return { kind: known, depth: Number(depth), session };
}

// A delegate is a leaf, an owner launches only delegates, and the tree stops at MAX_DEPTH.
function treeRefusals(parent: TreePosition, kind: Kind): string[] {
  const depth = parent.kind === "root" ? 1 : parent.depth + 1;

  return [
    ...(parent.kind === "delegate" ? ["a delegate launches nothing"] : []),
    ...(parent.kind === "owner" && kind === "owner" ? ["an owner launches only delegates (--kind delegate)"] : []),
    ...(depth > MAX_DEPTH ? [`depth ${depth} is past the limit of ${MAX_DEPTH}`] : []),
  ];
}

interface Skill {
  readonly name: string;
  readonly directory: string;
}

// Each name resolves to the harness's skill first, then to the launch directory's project skill.
function resolveSkills(brief: string, names: readonly string[]): Skill[] {
  const roots = [SKILLS_DIRECTORY, join(process.cwd(), ".agents", "skills")];
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
  readonly name: string;
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
    name,
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

// The child's own position, which the launcher hands it, and the state folder it registers in.
function childEnvironment(child: Child, options: Options): Record<string, string> {
  return {
    PI_SUBAGENT_KIND: child.kind,
    PI_SUBAGENT_TREE_DEPTH: String(child.depth),
    PI_SUBAGENT_SESSION: child.session,
    ...(options.state === null ? {} : { IMPLEMENT_CHUNK_STATE: options.state }),
  };
}

type Child = Extract<TreePosition, { readonly session: string }>;

function childOf(parent: TreePosition, options: Options, launch: Launch): Child {
  return { kind: options.kind, depth: parent.kind === "root" ? 1 : parent.depth + 1, session: launch.session };
}

function printDryRun(launch: Launch, options: Options, parent: TreePosition): void {
  const child = childOf(parent, options, launch);
  const environment = Object.entries(childEnvironment(child, options)).map(([name, value]) => `${name}=${value}`);
  const out: string[] = [
    "launch: dry run, no Pi process started",
    `command: pi-subagent ${launch.argv.map(shellQuote).join(" ")}`,
    `session: ${launch.session}${options.resume === null ? " (new)" : " (resumed)"}`,
    `tree: ${child.kind} at depth ${child.depth}, parent ${parent.kind === "root" ? "root" : `${parent.session} (${parent.kind})`}`,
    `environment: ${environment.join(" ")}`,
    `registry: ${options.state === null ? "none" : `${join(options.state, "spawns.tsv")}, written only by a real launch`}`,
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

type ChunkResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

function runChunk(state: string, words: readonly string[]): ChunkResult {
  const result = spawnSync(process.execPath, [CHUNK, "--state", state, "spawn", ...words], { encoding: "utf8" });

  if (result.error !== undefined) return { ok: false, message: result.error.message };

  if (result.status !== 0) return { ok: false, message: result.stderr.trim() };

  return { ok: true };
}

// The child's row lands before Pi starts, so no subagent runs unregistered. A resume runs an
// existing row again under the parent that resumed it, which may differ from the one that
// launched it (the coordinator resumes a child whose owner ended); kind, role, unit, and name
// stay as recorded.
function registerSpawn(state: string, parent: TreePosition, child: Child, options: Options, launch: Launch): void {
  const position = [`parent=${parent.kind === "root" ? "root" : parent.session}`, `depth=${child.depth}`];
  const words =
    options.resume === null
      ? [
          "add",
          child.session,
          ...position,
          `kind=${child.kind}`,
          `role=${options.role}`,
          `unit=${options.unit}`,
          `name=${launch.name}`,
        ]
      : ["set", child.session, ...position, "state=running"];
  const result = runChunk(state, words);

  if (!result.ok)
    throw new Refusal([`could not register the spawn in ${join(state, "spawns.tsv")}: ${result.message}`]);
}

function recordSpawnEnd(state: string, session: string, exit: number): void {
  const result = runChunk(state, ["set", session, `state=${exit === 0 ? "reported" : "failed"}`]);

  if (!result.ok)
    process.stderr.write(`launch: could not record the end of spawn ${session} in ${join(state, "spawns.tsv")}: ${result.message}\n`);
}

async function runChild(launch: Launch, env: Readonly<Record<string, string>>): Promise<number> {
  const child = spawn("pi-subagent", [...launch.argv], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
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
    const parent = treePosition(process.env);
    const refusals = treeRefusals(parent, options.kind);

    if (refusals.length > 0) throw new Refusal(refusals);

    if (options.state !== null && !existsSync(options.state))
      throw new Refusal([`state folder ${options.state} does not exist`]);

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
      printDryRun(launch, options, parent);

      return 0;
    }

    const child = childOf(parent, options, launch);

    if (options.state !== null) registerSpawn(options.state, parent, child, options, launch);

    process.stderr.write(`launch: session ${launch.session}\n`);

    const exit = await runChild(launch, childEnvironment(child, options));

    if (options.state !== null) recordSpawnEnd(options.state, launch.session, exit);

    return exit;
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
