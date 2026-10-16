import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DELEGATE_PROMPT = "skills/subagents/delegate.md";

const BLOCK_REASON =
  "Delegates spawn nothing. Finish your piece, and name in your report the helper your parent should spawn.";

const LINE_CONTINUATION = /\\\r?\n/g;

const PI_PRINT = /(?:^|[\s;&|(`/])pi\s(?:[^;&|\n]*?\s)?(?:--print|-p)(?=$|[\s;&|`)])/m;

export function isDelegateLaunch(argv: readonly string[]): boolean {
  return argv.some(
    (arg, index) =>
      arg === "--append-system-prompt" && (argv[index + 1]?.endsWith(DELEGATE_PROMPT) ?? false),
  );
}

export function spawnsPiPrint(command: string): boolean {
  return PI_PRINT.test(command.replace(LINE_CONTINUATION, " "));
}

export default function delegateGuard(pi: ExtensionAPI): void {
  if (!isDelegateLaunch(process.argv)) return;

  pi.on("tool_call", (event) => {
    const runsCommand =
      isToolCallEventType("bash", event) ||
      isToolCallEventType<"bg_start", { command: string }>("bg_start", event);

    if (runsCommand && spawnsPiPrint(event.input.command)) {
      return { block: true, reason: BLOCK_REASON };
    }

    return undefined;
  });
}
