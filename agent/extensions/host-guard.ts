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
import type { WordForm } from "../lib/shell-script.ts";

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

// `${NAME:-default}`, `${NAME-default}`, `${NAME:=default}`, or `${NAME=default}` at the
// start of a word, which expands to its default when NAME is unset, as TMPDIR is here.
const DEFAULTED_EXPANSION = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]([^}]*)\}/;

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

const GUARDED_WHERE =
  "as a command name, a script a shell runs, or an argument of kill, rm, find, xargs, or fuser";

const KILL_REASON =
  "Kill only processes you started. A kill by name, pattern, port, or file, such as pkill, killall, fuser -k, kill $(pgrep …), or kill $(lsof -t …), also reaches other agents' processes on this shared host. Stop a background terminal with bg_kill, or kill a PID you started.";

const TMP_GLOB_REASON =
  "Delete only the directory you created, by its exact path. A glob under /tmp, /var/tmp, or TMPDIR, or a delete of /tmp or /var/tmp itself or of everything under them, such as find /tmp -delete or a variable whose default is /tmp, also reaches other agents' scratch directories on this shared host. Make a scratch directory with mktemp -d, and remove it with rm -rf and the path mktemp printed.";

const UNREAD_ECHO_REASON =
  "The host guard cannot read what this echo prints into a shell, because its text uses an escape that echo versions print differently, or, without -e, a backslash escape that some echo versions read anyway. Write the script as a quoted heredoc instead, such as bash <<'EOF' … EOF.";

const UNREAD_PRINTF_REASON =
  "The host guard cannot read what this printf prints into a shell, because its format uses a width, a precision, a flag, *, a conversion other than %s, %b, and %%, or an escape that printf versions print differently. Write the script as a quoted heredoc instead, such as bash <<'EOF' … EOF.";

// What the reason for refusing each unread word form says: the form, why the guard
// cannot read it, where the guard refuses it, and how to write it instead.
const UNREAD_WORDS: Readonly<Record<WordForm, readonly [string, string, string, string]>> = {
  "ansi-c": [
    "ANSI-C quoted $'…' word",
    "it uses \\u, \\U, \\c, or a number escape for NUL or a byte above 0x7F",
    GUARDED_WHERE,
    "write the word without that escape",
  ],
  locale: [
    'locale-quoted $"…" word',
    "bash may translate its text through the locale's message catalog",
    GUARDED_WHERE,
    "quote it with plain double quotes",
  ],
  brace: [
    "brace expansion, such as {a,b} or {1..3}",
    "the guard reads a brace expansion only where it makes the words bash makes, and this one makes more than 1024 words, or uses a range with a non-letter, a number of more than 15 digits, a line continuation, or a substitution the guard does not expand",
    GUARDED_WHERE,
    "write each word out",
  ],
  "dollar-bracket": [
    "$[…] arithmetic",
    "the guard does not read this deprecated form",
    GUARDED_WHERE,
    "write it as $((…))",
  ],
  pattern: [
    "unquoted *, ?, or […] pattern",
    "bash replaces it with the file names it matches",
    "as a command name or in a script a shell runs",
    "quote it, or write the exact path",
  ],
};

function unreadWordReason(form: WordForm): string {
  const [word, because, where, instead] = UNREAD_WORDS[form];

  return `The host guard cannot read this ${word}, because ${because}. The guard refuses such a word unread ${where}. Write the script as a quoted heredoc instead, such as bash <<'EOF' … EOF, or ${instead}.`;
}

// Commands whose arguments the host guard reads to find a kill or a delete.
const GUARDED_NAMES: ReadonlySet<string> = new Set([
  ...KILL_BY_NAME,
  "find",
  "fuser",
  "kill",
  "rm",
  "xargs",
]);

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

// A word as written, and with a leading defaulted expansion replaced by its default.
function readings(word: string): readonly string[] {
  return [word, word.replace(DEFAULTED_EXPANSION, "$1")];
}

function isSystemTmp(word: string): boolean {
  return readings(word).some((reading) => SYSTEM_TMP_ITSELF.test(reading));
}

// Whether an `rm` argument is a glob under a temp directory, or /tmp or /var/tmp itself.
function deletesTmp(word: string): boolean {
  return readings(word).some(deletesTmpAsWritten);
}

function deletesTmpAsWritten(word: string): boolean {
  const root = TMP_ROOT.exec(word)?.[0];

  if (root === undefined) return false;

  return GLOB.test(word.slice(root.length)) || SYSTEM_TMP_ITSELF.test(word);
}

// The words after find's options -H, -L, -P, -O<level>, and -D, and after a `--` that
// ends them. The argument of -D stays, read as a start path, which can only add one.
function findPathsAndExpression(args: readonly string[]): readonly string[] {
  let index = 0;

  while (index < args.length) {
    const word = args[index] ?? "";

    if (word === "--") return args.slice(index + 1);

    if (!/^-(?:[HLP]+|O\d*|D.*)$/.test(word)) return args.slice(index);

    index += 1;
  }

  return [];
}

// Whether `find` deletes what it finds in /tmp or /var/tmp itself, or in a temp
// directory by a name glob.
function findDeletesTmp(args: readonly string[]): boolean {
  const words = findPathsAndExpression(args);
  // find's expression starts at its first test, `(`, or `!`, after its start paths.
  const expression = words.findIndex((word) => /^[-(!]/.test(word));
  const starts = expression === -1 ? words : words.slice(0, expression);
  const tests = expression === -1 ? [] : words.slice(expression);
  const after = (index: number): string => tests[index + 1] ?? "";
  const searchesTmp = starts.some((word) => TMP_ROOT.test(word));

  const matchesGlob = tests.some(
    (word, index) => FIND_NAME_TESTS.has(word) && GLOB.test(after(index)),
  );

  const deletes = tests.some(
    (word, index) =>
      word === "-delete" || (FIND_EXEC_ACTIONS.has(word) && basename(after(index)) === "rm"),
  );

  return deletes && ((searchesTmp && matchesGlob) || starts.some(isSystemTmp));
}

function deletesTmpGlob({ argv }: Command): boolean {
  const { name, args } = invocation(argv);

  if (name === "find") return findDeletesTmp(args);

  return name === "rm" && args.some(deletesTmp);
}

export function hostGuard(command: string): string | undefined {
  const parsed = parseCommand(command);

  if (parsed.kind === "too-deep") return nestingReason(parsed.limit);

  const all = parsed.pipelines;
  const variables = pidVariables(all);

  if (all.some((pipeline) => killsByPattern(pipeline, variables))) return KILL_REASON;

  if (all.flat().some(deletesTmpGlob)) return TMP_GLOB_REASON;

  const { unreadBy } = parsed;

  const guarded = parsed.unreadArguments.find(({ argv }) =>
    GUARDED_NAMES.has(invocation(argv).name),
  );

  const printerUnread = unreadBy === "echo" || unreadBy === "printf";
  const unreadWord = printerUnread ? guarded?.form : (unreadBy ?? guarded?.form);

  if (unreadWord !== undefined) return unreadWordReason(unreadWord);

  if (unreadBy === "printf") return UNREAD_PRINTF_REASON;

  if (unreadBy === "echo") return UNREAD_ECHO_REASON;

  return undefined;
}

export default function hostGuardExtension(pi: ExtensionAPI): void {
  refuseCommands(pi, hostGuard);
}
