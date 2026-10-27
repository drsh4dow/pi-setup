import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { refuseCommands } from "../lib/command-tool-call.ts";
import {
  basename,
  commandArgv,
  parseCommand,
  withNested,
  type Command,
  type Pipeline,
} from "../lib/shell-command.ts";

const KILL_BY_NAME: ReadonlySet<string> = new Set(["pkill", "killall"]);

const PID_SEARCH: ReadonlySet<string> = new Set(["lsof", "pgrep", "pidof", "ps"]);

// Builtins that assign their `name=value` arguments.
const DECLARATIONS: ReadonlySet<string> = new Set([
  "declare",
  "export",
  "local",
  "readonly",
  "typeset",
]);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/;

// find's tests whose argument is a name or path pattern.
const FIND_NAME_TESTS: ReadonlySet<string> = new Set([
  "-ipath",
  "-iname",
  "-iwholename",
  "-name",
  "-path",
  "-wholename",
]);

const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

// A temp directory at the start of a path: /tmp, /var/tmp, $TMPDIR, or ${TMPDIR…}.
const TMP_ROOT = /^(?:\/tmp|\/var\/tmp|\$TMPDIR|\$\{TMPDIR(?:[^A-Za-z0-9_}][^}]*)?\})(?=\/|$)/;

// /tmp or /var/tmp itself, which every agent shares, with any trailing `/` or `.`.
const SYSTEM_TMP_ITSELF = /^\/(?:var\/)?tmp[/.]*$/;

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
  "Kill only processes you started. A kill by name, pattern, port, or file, such as pkill, killall, fuser -k, kill $(pgrep …), or kill $(lsof -t …), also reaches other agents' processes on this shared host. Stop a background terminal with bg_kill, or kill a PID you started.";

const TMP_GLOB_REASON =
  "Delete only the directory you created, by its exact path. A glob under /tmp, /var/tmp, or TMPDIR, or a delete of /tmp or /var/tmp itself, also reaches other agents' scratch directories on this shared host. Make a scratch directory with mktemp -d, and remove it with rm -rf and the path mktemp printed.";

function nestingReason(limit: number): string {
  return `This command nests deeper than the host guard reads (${limit} levels), so the guard refuses it unread. Split it into smaller commands, or write the script to a file and run that.`;
}

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

// The variables a command assigns, such as `pids` in `pids=$(pgrep x)` or `export pids=…`.
function assignedNames(argv: readonly string[]): string[] {
  const [word, ...args] = commandArgv(argv);

  if (word !== undefined && !DECLARATIONS.has(word)) return [];

  // A command of only assignments has no command word, so every word may assign.
  const assignments = word === undefined ? argv : args;

  return assignments.flatMap((assignment) => ASSIGNMENT.exec(assignment)?.[1] ?? []);
}

// The variables the pipelines assign from a PID search, such as `pids=$(pgrep x)`.
function pidVariables(all: readonly Pipeline[]): ReadonlySet<string> {
  return new Set(
    all
      .flat()
      .filter((command) => withNested(command).some(isPidSearch))
      .flatMap(({ argv }) => assignedNames(argv)),
  );
}

// Whether a command finds PIDs by pattern: it is a PID search, or a word uses a variable
// that a PID search assigned.
function findsPids(command: Command, variables: ReadonlySet<string>): boolean {
  return (
    isPidSearch(command) ||
    command.argv.some((word) =>
      [...variables].some((name) => new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`).test(word)),
    )
  );
}

// `fuser -k` kills every process that uses a file or port.
function isFuserKill(name: string, args: readonly string[]): boolean {
  return name === "fuser" && args.some((word) => word === "--kill" || /^-[A-Za-z0-9]*k/.test(word));
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

function killsByPattern(pipeline: Pipeline, variables: ReadonlySet<string>): boolean {
  const findPids = (command: Command): boolean => findsPids(command, variables);

  return pipeline.some((command, index) => {
    const { name, args } = invocation(command.argv);

    if (KILL_BY_NAME.has(name) || isFuserKill(name, args)) return true;

    if (name === "kill") return withNested(command).some(findPids);

    if (name !== "xargs") return false;

    const runs = invocation(xargsCommand(args)).name;

    return (
      KILL_BY_NAME.has(runs) ||
      (runs === "kill" && pipeline.slice(0, index).flatMap(withNested).some(findPids))
    );
  });
}

// Whether an `rm` argument is a glob under a temp directory, or /tmp or /var/tmp itself.
function deletesTmp(word: string): boolean {
  const root = TMP_ROOT.exec(word)?.[0];

  if (root === undefined) return false;

  return GLOB.test(word.slice(root.length)) || SYSTEM_TMP_ITSELF.test(word);
}

// Whether `find` searches a temp directory by a name glob and deletes what it finds.
function findDeletesTmpGlob(args: readonly string[]): boolean {
  // find's expression starts at its first test, `(`, or `!`; -H, -L, -P, and -O are
  // options before the paths.
  const expression = args.findIndex((word) => /^[-(!]/.test(word) && !/^-[HLPO]/.test(word));
  const starts = expression === -1 ? args : args.slice(0, expression);
  const tests = expression === -1 ? [] : args.slice(expression);
  const after = (index: number): string => tests[index + 1] ?? "";
  const searchesTmp = starts.some((word) => TMP_ROOT.test(word));

  const matchesGlob = tests.some(
    (word, index) => FIND_NAME_TESTS.has(word) && GLOB.test(after(index)),
  );

  const deletes = tests.some(
    (word, index) =>
      word === "-delete" || (FIND_EXEC_ACTIONS.has(word) && basename(after(index)) === "rm"),
  );

  return searchesTmp && matchesGlob && deletes;
}

function deletesTmpGlob({ argv }: Command): boolean {
  const { name, args } = invocation(argv);

  if (name === "find") return findDeletesTmpGlob(args);

  return name === "rm" && args.some(deletesTmp);
}

export function hostGuard(command: string): string | undefined {
  const parsed = parseCommand(command);

  if (parsed.kind === "too-deep") return nestingReason(parsed.limit);

  const all = parsed.pipelines;
  const variables = pidVariables(all);

  if (all.some((pipeline) => killsByPattern(pipeline, variables))) return KILL_REASON;

  if (all.flat().some(deletesTmpGlob)) return TMP_GLOB_REASON;

  return undefined;
}

export default function hostGuardExtension(pi: ExtensionAPI): void {
  refuseCommands(pi, hostGuard);
}
