import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { refuseCommands } from "../lib/command-tool-call.ts";
import {
  basename,
  commandArgv,
  pipelines,
  withNested,
  type Command,
  type Pipeline,
} from "../lib/shell-command.ts";

const KILL_BY_NAME: ReadonlySet<string> = new Set(["pkill", "killall"]);

const PID_SEARCH: ReadonlySet<string> = new Set(["pgrep", "pidof", "ps"]);

// GNU xargs options that take the next word as their argument when written last in a group.
const XARGS_SHORT_OPTIONS_WITH_ARGUMENT = new Set(["a", "d", "E", "I", "L", "n", "P", "s"]);

// GNU xargs options whose argument is attached or absent: `-i{}`, `-e`, `-l1`.
const XARGS_SHORT_OPTIONS_WITH_ATTACHED_ARGUMENT = new Set(["e", "i", "l"]);

const XARGS_LONG_OPTIONS_WITH_ARGUMENT: ReadonlySet<string> = new Set([
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-chars",
  "--max-procs",
  "--process-slot-var",
]);

const KILL_REASON =
  "Kill only processes you started. A kill by name or pattern, such as pkill, killall, or kill $(pgrep …), also reaches other agents' processes on this shared host. Stop a background terminal with bg_kill, or kill a PID you started.";

const TMP_GLOB_REASON =
  "Delete only the directory you created, by its exact path. A glob under /tmp also matches other agents' scratch directories on this shared host. Make a scratch directory with mktemp -d, and remove it with rm -rf and the path mktemp printed.";

const GLOB = /[*?[]/;

interface Invocation {
  readonly name: string;
  readonly args: readonly string[];
}

function invocation(argv: readonly string[]): Invocation {
  const [word, ...args] = commandArgv(argv);

  return { name: word === undefined ? "" : basename(word), args };
}

function isPidSearch({ argv }: Command): boolean {
  return PID_SEARCH.has(invocation(argv).name);
}

// Whether a flag group such as `-rn` takes the next word as its argument.
function xargsFlagsTakeNextWord(flags: string): boolean {
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags.charAt(index);

    if (XARGS_SHORT_OPTIONS_WITH_ATTACHED_ARGUMENT.has(flag)) return false;

    if (XARGS_SHORT_OPTIONS_WITH_ARGUMENT.has(flag)) return index === flags.length - 1;
  }

  return false;
}

// The command xargs runs, given the words after `xargs`.
function xargsCommand(args: readonly string[]): readonly string[] {
  let index = 0;

  while (index < args.length) {
    const word = args[index] ?? "";

    if (word === "--") return args.slice(index + 1);

    if (!word.startsWith("-") || word === "-") return args.slice(index);

    const takesNextWord = word.startsWith("--")
      ? XARGS_LONG_OPTIONS_WITH_ARGUMENT.has(word)
      : xargsFlagsTakeNextWord(word.slice(1));

    index += takesNextWord ? 2 : 1;
  }

  return [];
}

function killsByPattern(pipeline: Pipeline): boolean {
  return pipeline.some((command, index) => {
    const { name, args } = invocation(command.argv);

    if (KILL_BY_NAME.has(name)) return true;

    if (name === "kill") return withNested(command).some(isPidSearch);

    return (
      name === "xargs" &&
      invocation(xargsCommand(args)).name === "kill" &&
      pipeline.slice(0, index).flatMap(withNested).some(isPidSearch)
    );
  });
}

function deletesTmpGlob({ argv }: Command): boolean {
  const { name, args } = invocation(argv);

  return name === "rm" && args.some((word) => word.startsWith("/tmp/") && GLOB.test(word));
}

export function hostGuard(command: string): string | undefined {
  const all = pipelines(command);

  if (all.some(killsByPattern)) return KILL_REASON;

  if (all.flat().some(deletesTmpGlob)) return TMP_GLOB_REASON;

  return undefined;
}

export default function hostGuardExtension(pi: ExtensionAPI): void {
  refuseCommands(pi, hostGuard);
}
