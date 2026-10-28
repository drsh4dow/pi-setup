// The guard judges each call synchronously inside Pi's handler, which has no Effect runtime.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { homedir, tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { fileURLToPath } from "node:url";

import {
  type ExtensionAPI,
  type ExtensionContext,
  isToolCallEventType,
  parseArgs,
} from "@earendil-works/pi-coding-agent";

import { refuseCommands } from "../lib/command-tool-call.ts";
import { basename, commandArgv, isShell, pipelines } from "../lib/shell-command.ts";
import { SH4DOW_MODE_ENTRY } from "./sh4dow/index.ts";

type LaunchKind = "root" | "owner" | "delegate";

type PiLaunchArgv = readonly string[];

// A subagent runs on a generated role prompt, and the directory that prompt sits in is its kind.
const OWNER_PROMPTS = "system/generated/owner/";

const DELEGATE_PROMPTS = "system/generated/delegate/";

// The delegate kind part, which the worker-questions eval appends to general mode's prompt.
const DELEGATE_KIND_PART = "system/kinds/delegate.md";

const LAUNCHER = "skills/subagents/scripts/launch.ts";

// Commands that only print or search their arguments, so a launch string in one is text.
const TEXT_COMMANDS: ReadonlySet<string> = new Set([
  "ack",
  "ag",
  "echo",
  "egrep",
  "fgrep",
  "grep",
  "printf",
  "rg",
]);

// An argument with a blank or a separator may be a command line that its program runs.
const COMMAND_LINE = /[\s;&|]/;

const DELEGATE_REASON =
  "Delegates spawn nothing. Finish your piece, and name in your report the helper your parent should spawn.";

const OWNER_REASON =
  "Owners launch only delegates. Pass --kind delegate to skills/subagents/scripts/launch.ts, and give every pi-subagent launch a --system-prompt from agent/system/generated/delegate/, per the subagents skill.";

// A prompt value that names a file: one line ending in .md. A prompt text that quotes a path is
// longer than one line or ends elsewhere, so it names no kind.
function isPromptPath(value: string): boolean {
  return !value.includes("\n") && value.endsWith(".md");
}

function isDelegateKindPart(value: string): boolean {
  return isPromptPath(value) && value.endsWith(DELEGATE_KIND_PART);
}

// The kind of a Pi process started with these options. Pi's own parser reads them, so `--` and
// option values count as they do for Pi, which takes the last --system-prompt as text or as a
// file path. An appended delegate kind part makes a delegate whatever the system prompt.
function promptKind(piOptions: readonly string[]): LaunchKind {
  const { systemPrompt, appendSystemPrompt = [] } = parseArgs([...piOptions]);

  if (appendSystemPrompt.some(isDelegateKindPart)) return "delegate";

  if (systemPrompt === undefined || !isPromptPath(systemPrompt)) return "root";

  if (systemPrompt.includes(OWNER_PROMPTS)) return "owner";

  if (systemPrompt.includes(DELEGATE_PROMPTS)) return "delegate";

  return "root";
}

function isPi(word: string): boolean {
  return word === "pi" || word.endsWith("/pi");
}

function isPiSubagent(word: string): boolean {
  return word === "pi-subagent" || word.endsWith("/pi-subagent");
}

// The brief launcher picks the role prompt itself, and its --kind flag names the kind.
function isLauncher(word: string): boolean {
  return word.endsWith(LAUNCHER);
}

// `pi-subagent` needs no flag to launch, so it counts only in command position.
// Otherwise `rg pi-subagent` and `test -x .../pi-subagent` would read as launches.
function piSubagentLaunch(argv: readonly string[]): PiLaunchArgv | undefined {
  const launch = commandArgv(argv);
  const commandWord = launch[0] ?? "";

  return isPiSubagent(commandWord) || isLauncher(commandWord) ? launch : undefined;
}

function launchOf(argv: readonly string[]): PiLaunchArgv | undefined {
  const subagentLaunch = piSubagentLaunch(argv);

  if (subagentLaunch !== undefined) return subagentLaunch;

  const piIndex = argv.findIndex(isPi);

  if (piIndex === -1) return undefined;

  const launch = argv.slice(piIndex);

  return launch.some((word) => word === "--print" || word === "-p") ? launch : undefined;
}

// A program such as `tmux new-session -d "…"`, `ssh host "…"`, or `watch "…"` runs its
// quoted argument as a command line, so that argument is judged as one. A launch's own
// arguments are its prompt, and a text command's are text unless its pipeline feeds a shell.
function subagentLaunches(command: string): PiLaunchArgv[] {
  return pipelines(command).flatMap((pipeline) => {
    const feedsShell = pipeline.slice(1).some(({ argv }) => isShell(argv[0] ?? ""));

    return pipeline.flatMap(({ argv }) => {
      const launch = launchOf(argv);

      if (launch !== undefined) return [launch];

      const [word = "", ...args] = commandArgv(argv);

      if (TEXT_COMMANDS.has(basename(word)) && !feedsShell) return [];

      return args.filter((arg) => COMMAND_LINE.test(arg)).flatMap(subagentLaunches);
    });
  });
}

function launcherKind(launch: PiLaunchArgv): string | undefined {
  return launch
    .flatMap((word, index) => {
      if (word.startsWith("--kind=")) return [word.slice("--kind=".length)];

      const next = launch[index + 1];

      return word === "--kind" && next !== undefined ? [next] : [];
    })
    .at(-1);
}

function launchesDelegate(launch: PiLaunchArgv): boolean {
  if (isLauncher(launch[0] ?? "")) return launcherKind(launch) === "delegate";

  return promptKind(launch.slice(1)) === "delegate";
}

export function spawnGuard(
  argv: readonly string[],
): ((command: string) => string | undefined) | undefined {
  // process.argv holds the runtime and Pi's entry script before Pi's options.
  const kind = promptKind(argv.slice(2));

  switch (kind) {
    case "root":
      return undefined;
    case "delegate":
      return (command) => {
        if (subagentLaunches(command).length === 0) return undefined;

        return DELEGATE_REASON;
      };

    case "owner":
      return (command) => {
        if (subagentLaunches(command).every(launchesDelegate)) return undefined;

        return OWNER_REASON;
      };

    default: {
      const unexpected: never = kind;
      throw new Error(`Unexpected launch kind: ${String(unexpected)}`);
    }
  }
}

// A coordinator is a root session in sh4dow mode or one that runs the implement-chunk prompt, the
// two kinds evals/coordinator-runs grades. It is read-only on code: subagents make every change,
// so its own edit and write calls stay in the state root and the temp directory.
// A session becomes a coordinator at any user message that opens with this heading as a whole line,
// which is how Pi records an expanded /implement-chunk, and stays one for the rest of the session.
const IMPLEMENT_CHUNK_HEADING = /^# Implement a chunk(?:\r?\n|$)/;

// The state folders of every project, which SYSTEM.md roots here. The guard cannot tell which
// chunk folder a coordinator owns, so any folder under the root counts as its own.
const STATE_ROOT = join(homedir(), ".local", "state", "pi-agent");

const ROOT_EDIT_REASON =
  "root-edit: a coordinator is read-only on code, so it writes only its state folder under " +
  `${STATE_ROOT} and scratch files in the temp directory. Brief a subagent to make this change.`;

type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

function userTexts(entries: SessionEntries): string[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];

    const { content } = entry.message;

    if (!Array.isArray(content)) return [content];

    return [content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
  });
}

export function isCoordinatorSession(entries: SessionEntries): boolean {
  const sh4dow = entries.some(
    (entry) => entry.type === "custom" && entry.customType === SH4DOW_MODE_ENTRY,
  );

  return (
    sh4dow || userTexts(entries).some((text) => IMPLEMENT_CHUNK_HEADING.test(text.trimStart()))
  );
}

// The Unicode spaces Pi's edit and write tools read as an ASCII space, as their resolveToCwd does
// (dist/utils/paths.js). The package does not export it, so the agreement test in
// test/delegate-guard-root-edit.test.ts holds this copy to Pi's real write tool.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The file an edit or write call names, resolved as Pi's tools resolve it: Unicode spaces read as
 * spaces, then a leading `@` dropped, `~` expanded, a file URL read as its path, and a relative path
 * taken from the session's directory.
 */
export function editTarget(path: string, cwd: string): string {
  const spaced = path.replace(UNICODE_SPACES, " ");
  const named = spaced.startsWith("@") ? spaced.slice(1) : spaced;

  if (named === "~") return homedir();

  if (named.startsWith("file://")) return resolve(fileURLToPath(named));

  return resolve(cwd, named.startsWith("~/") ? join(homedir(), named.slice(2)) : named);
}

// Past this many links the filesystem refuses the path too (ELOOP), so the guard stops following.
const MAX_LINKS = 40;

// Where a write to this absolute path lands: the real path of its nearest existing ancestor, with
// the missing rest appended. A dangling link is followed from the directory it really sits in,
// since writing through it creates its target.
function landingOf(path: string, links = 0): string {
  const stats = lstatSync(path, { throwIfNoEntry: false });

  if (stats !== undefined && !stats.isSymbolicLink()) return realpathSync.native(path);

  const parent = dirname(path);

  if (parent === path) return path;

  const here = join(landingOf(parent, links), relative(parent, path));

  if (stats === undefined || links >= MAX_LINKS) return here;

  return landingOf(resolve(dirname(here), readlinkSync(here)), links + 1);
}

// Undefined when the filesystem refuses to resolve the path, as it would refuse the write.
function landingOrUnknown(path: string): string | undefined {
  try {
    return landingOf(path);
  } catch {
    return undefined;
  }
}

// Inside by whole segments, so `/tmp/..notes` is a child of /tmp and `/tmp/../home` is not.
function isInside(directory: string, path: string): boolean {
  const rest = relative(directory, path);

  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

/** Why a coordinator may not write `path`, or undefined when it lands in the state root or a temp directory. */
export function rootEditRefusal(path: string, cwd: string): string | undefined {
  const target = editTarget(path, cwd);
  const landing = landingOrUnknown(target);

  if (landing === undefined) {
    return `${ROOT_EDIT_REASON} Refused: ${target}, which does not resolve`;
  }

  const allowed = [STATE_ROOT, tmpdir(), "/tmp"].flatMap((root) => landingOrUnknown(root) ?? []);

  if (allowed.some((directory) => isInside(directory, landing))) return undefined;

  const refused = landing === target ? target : `${target}, which lands at ${landing}`;

  return `${ROOT_EDIT_REASON} Refused: ${refused}`;
}

export function refuseRootEdits(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    const writes = isToolCallEventType("edit", event) || isToolCallEventType("write", event);

    if (!writes || !isCoordinatorSession(ctx.sessionManager.getEntries())) return undefined;

    const reason = rootEditRefusal(event.input.path, ctx.cwd);

    return reason === undefined ? undefined : { block: true, reason };
  });
}

export default function delegateGuard(pi: ExtensionAPI): void {
  if (promptKind(process.argv.slice(2)) === "root") refuseRootEdits(pi);

  const blockReason = spawnGuard(process.argv);

  if (blockReason === undefined) return;

  refuseCommands(pi, blockReason);
}
