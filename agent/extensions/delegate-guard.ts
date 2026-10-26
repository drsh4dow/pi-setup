import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { commandIndex, simpleCommands } from "../lib/shell-command.ts";

type LaunchKind = "root" | "owner" | "delegate";

type PiLaunchArgv = readonly string[];

const UNATTENDED_PROMPT = "skills/subagents/unattended.md";

const OWNER_PROMPT = "skills/subagents/owner.md";

const DELEGATE_PROMPT = "skills/subagents/delegate.md";

const LAUNCHER = "skills/subagents/scripts/launch.ts";

const DELEGATE_REASON =
  "Delegates spawn nothing. Finish your piece, and name in your report the helper your parent should spawn.";

const OWNER_REASON =
  "Owners launch only delegates. Append skills/subagents/delegate.md to every pi-subagent launch, and pass --kind delegate to skills/subagents/scripts/launch.ts, per the subagents skill.";

function appendedPrompts(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) => {
    const next = argv[index + 1];

    if (arg === "--append-system-prompt" && next !== undefined) return [next];

    return [];
  });
}

function launchKind(argv: readonly string[]): LaunchKind {
  const prompts = appendedPrompts(argv);

  if (!prompts.some((prompt) => prompt.endsWith(UNATTENDED_PROMPT))) return "root";

  if (prompts.some((prompt) => prompt.endsWith(OWNER_PROMPT))) return "owner";

  return "delegate";
}

function isPi(word: string): boolean {
  return word === "pi" || word.endsWith("/pi");
}

function isPiSubagent(word: string): boolean {
  return word === "pi-subagent" || word.endsWith("/pi-subagent");
}

// The brief launcher appends the kind file itself, named by its --kind flag.
function isLauncher(word: string): boolean {
  return word.endsWith(LAUNCHER);
}

// `pi-subagent` needs no flag to launch, so it counts only in command position.
// Otherwise `rg pi-subagent` and `test -x .../pi-subagent` would read as launches.
function piSubagentLaunch(argv: readonly string[]): PiLaunchArgv | undefined {
  const index = commandIndex(argv);
  const commandWord = argv[index];

  if (commandWord === undefined || !(isPiSubagent(commandWord) || isLauncher(commandWord)))
    return undefined;

  return argv.slice(index);
}

function subagentLaunches(command: string): PiLaunchArgv[] {
  return simpleCommands(command).flatMap((argv) => {
    const subagentLaunch = piSubagentLaunch(argv);

    if (subagentLaunch !== undefined) return [subagentLaunch];

    const piIndex = argv.findIndex(isPi);

    if (piIndex === -1) return [];

    const launch = argv.slice(piIndex);

    if (!launch.some((word) => word === "--print" || word === "-p")) return [];

    return [launch];
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

  const prompts = appendedPrompts(launch);

  return (
    prompts.some((prompt) => prompt.endsWith(DELEGATE_PROMPT)) &&
    !prompts.some((prompt) => prompt.endsWith(OWNER_PROMPT))
  );
}

export function spawnGuard(
  argv: readonly string[],
): ((command: string) => string | undefined) | undefined {
  const kind = launchKind(argv);

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

  pi.on("tool_call", (event) => {
    const runsCommand =
      isToolCallEventType("bash", event) ||
      isToolCallEventType<"bg_start", { command: string }>("bg_start", event);

    if (!runsCommand) return undefined;

    const reason = blockReason(event.input.command);

    if (reason === undefined) return undefined;

    return { block: true, reason };
  });
}
