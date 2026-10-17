import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type LaunchKind = "root" | "owner" | "delegate";

type PiLaunchArgv = readonly string[];

const UNATTENDED_PROMPT = "skills/subagents/unattended.md";

const OWNER_PROMPT = "skills/subagents/owner.md";

const DELEGATE_PROMPT = "skills/subagents/delegate.md";

const DELEGATE_REASON =
  "Delegates spawn nothing. Finish your piece, and name in your report the helper your parent should spawn.";

const OWNER_REASON =
  "Owners launch only delegates. Append skills/subagents/delegate.md to every pi-subagent launch, per the subagents skill.";

const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([^\s'"<>;&|()]+)\2/g;

const LINE_CONTINUATION = /\\\r?\n/g;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// `&` next to `<` or `>` is a redirection such as `2>&1`, not a separator.
const COMMAND_SEPARATOR = /&&|\|\||;|\||(?<![<>])&(?!>)|\r?\n/;

interface HeredocTerminator {
  readonly word: string;
  readonly stripsTabs: boolean;
}

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

function withoutHeredocBodies(command: string): string {
  const kept: string[] = [];
  const pending: HeredocTerminator[] = [];

  for (const line of command.split("\n")) {
    const terminator = pending[0];

    if (terminator !== undefined) {
      const candidate = terminator.stripsTabs ? line.replace(/^\t+/, "") : line;

      if (candidate.replace(/\r$/, "") === terminator.word) pending.shift();
      continue;
    }

    kept.push(line);

    for (const match of line.matchAll(HEREDOC)) {
      pending.push({ word: match[3], stripsTabs: match[1] === "-" });
    }
  }

  return kept.join("\n");
}

function words(simpleCommand: string): string[] {
  return simpleCommand
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => word.replaceAll(/["']/g, ""));
}

function isPi(word: string): boolean {
  return word === "pi" || word.endsWith("/pi");
}

function isPiSubagent(word: string): boolean {
  return word === "pi-subagent" || word.endsWith("/pi-subagent");
}

function subagentLaunches(command: string): PiLaunchArgv[] {
  const joined = withoutHeredocBodies(command).replace(LINE_CONTINUATION, " ");

  return joined.split(COMMAND_SEPARATOR).flatMap((simpleCommand) => {
    const argv = words(simpleCommand);
    const commandIndex = argv.findIndex((word) => !ENV_ASSIGNMENT.test(word));
    const commandWord = argv[commandIndex];

    // Only the command word counts, so `rg pi-subagent` or `test -x .build/bin/pi-subagent` still runs.
    if (commandWord !== undefined && isPiSubagent(commandWord)) return [argv.slice(commandIndex)];

    const piIndex = argv.findIndex(isPi);

    if (piIndex === -1) return [];

    const launch = argv.slice(piIndex);

    if (!launch.some((word) => word === "--print" || word === "-p")) return [];

    return [launch];
  });
}

function launchesDelegate(launch: PiLaunchArgv): boolean {
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
