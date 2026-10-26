import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Refuses every agent tool call that runs a shell command (`bash` and `bg_start`)
 * whose command `refusal` gives a reason for. A codemode script's nested calls
 * reach the same handler. Other tools are not judged.
 */
export function refuseCommands(
  pi: ExtensionAPI,
  refusal: (command: string) => string | undefined,
): void {
  pi.on("tool_call", (event) => {
    const runsCommand =
      isToolCallEventType("bash", event) ||
      isToolCallEventType<"bg_start", { command: string }>("bg_start", event);

    if (!runsCommand) return undefined;

    const reason = refusal(event.input.command);

    if (reason === undefined) return undefined;

    return { block: true, reason };
  });
}
