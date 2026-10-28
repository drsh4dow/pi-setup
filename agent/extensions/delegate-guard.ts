import { type ExtensionAPI, parseArgs } from "@earendil-works/pi-coding-agent";

import { refuseCommands } from "../lib/command-tool-call.ts";
import { basename, commandArgv, isShell, pipelines } from "../lib/shell-command.ts";

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

export default function delegateGuard(pi: ExtensionAPI): void {
  const blockReason = spawnGuard(process.argv);

  if (blockReason === undefined) return;

  refuseCommands(pi, blockReason);
}
