import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { commandIndex, simpleCommands } from "../lib/shell-command.ts";

const KILL_BY_NAME: ReadonlySet<string> = new Set(["pkill", "killall"]);

// Commands that find PIDs by name or pattern.
const PID_SEARCH: ReadonlySet<string> = new Set(["pgrep", "pidof", "ps"]);

// `$(pgrep …)`, `"$(pidof …)"`, or the backtick form, once quotes are stripped.
const PID_SEARCH_SUBSTITUTION = /(?:\$\(|`)\s*(?:\S*\/)?(?:pgrep|pidof|ps)(?:\s|\)|`|$)/;

const KILL_REASON =
  "Kill only processes you started: a kill by name or pattern (pkill, killall, kill $(pgrep …)) also reaches other agents' processes on this shared host. Stop a background terminal with bg_kill, or kill a PID you started, by its number.";

const TMP_GLOB_REASON =
  'Delete only the directory you created, by its exact path: a glob under /tmp also matches other agents\' scratch directories on this shared host. Make scratch with scratch=$(mktemp -d) and remove it with rm -rf "$scratch".';

const GLOB = /[*?[]/;

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

interface SimpleCommand {
  readonly name: string;
  readonly args: readonly string[];
}

function simpleCommand(argv: readonly string[]): SimpleCommand {
  const index = commandIndex(argv);

  if (index === -1) return { name: "", args: [] };

  return { name: basename(argv[index] ?? ""), args: argv.slice(index + 1) };
}

// `xargs kill` kills the PIDs piped to it, so after a PID search it is a pattern kill.
function isXargsKill({ name, args }: SimpleCommand): boolean {
  return name === "xargs" && args.some((word) => basename(word) === "kill");
}

function killsByPattern(commands: readonly SimpleCommand[]): boolean {
  return commands.some((command, index) => {
    if (KILL_BY_NAME.has(command.name)) return true;

    if (command.name === "kill") return PID_SEARCH_SUBSTITUTION.test(command.args.join(" "));

    return (
      isXargsKill(command) && commands.slice(0, index).some(({ name }) => PID_SEARCH.has(name))
    );
  });
}

function deletesTmpGlob(commands: readonly SimpleCommand[]): boolean {
  return commands.some(
    ({ name, args }) =>
      name === "rm" && args.some((word) => word.startsWith("/tmp/") && GLOB.test(word)),
  );
}

export function hostGuard(command: string): string | undefined {
  const commands = simpleCommands(command).map(simpleCommand);

  if (killsByPattern(commands)) return KILL_REASON;

  if (deletesTmpGlob(commands)) return TMP_GLOB_REASON;

  return undefined;
}

export default function hostGuardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    const runsCommand =
      isToolCallEventType("bash", event) ||
      isToolCallEventType<"bg_start", { command: string }>("bg_start", event);

    if (!runsCommand) return undefined;

    const reason = hostGuard(event.input.command);

    if (reason === undefined) return undefined;

    return { block: true, reason };
  });
}
