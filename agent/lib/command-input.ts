// Reads which shell code a simple command runs beyond its own words, for the shell
// command reader in shell-command.ts: the operand of `bash -c`, `eval`, or `env -S`,
// the command a runner such as `tmux new-session` or `watch` starts, and whether a
// shell reads its script from stdin.

import { basename, commandArgv, commandStart, isShell } from "./command-word.ts";

/** The shell code a simple command runs beyond its own words. */
export type CommandInput =
  | { readonly kind: "none" }
  /** A shell with no command operand, which runs the script on its stdin. */
  | { readonly kind: "stdin" }
  /** `bash -c`, `eval`, or `env -S`: the words only wrap `text`, which is what runs. */
  | { readonly kind: "operand"; readonly text: string }
  /** A runner such as `tmux new-session` or `watch`, which starts these command lines. */
  | { readonly kind: "runner"; readonly commands: readonly string[] };

interface RunnerOptions {
  /** Short options that take an argument, attached (`-n1`) or as the next word (`-n 1`). */
  readonly short: string;
  /** Long options that take the next word as their argument, unless written `--name=value`. */
  readonly long: ReadonlySet<string>;
  /** Options after which the runner executes its words directly instead of through `sh -c`. */
  readonly exec: ReadonlySet<string>;
  /**
   * What several trailing words mean: tmux executes them directly, and watch joins
   * them with spaces into one `sh -c` command line.
   */
  readonly words: "argv" | "joined";
}

function tmuxCommand(short: string): RunnerOptions {
  return { short, long: new Set<string>(), exec: new Set<string>(), words: "argv" };
}

const TMUX_NEW_SESSION = tmuxCommand("cefFnstxy");

const TMUX_NEW_WINDOW = tmuxCommand("ceFnt");

const TMUX_SPLIT_WINDOW = tmuxCommand("BceFlmpRsStT");

const TMUX_RESPAWN = tmuxCommand("cet");

const WATCH: RunnerOptions = {
  short: "nq",
  long: new Set(["--equexit", "--interval"]),
  exec: new Set(["-x", "--exec"]),
  words: "joined",
};

/**
 * Programs that run their trailing words as a command, keyed by the program and,
 * for tmux, its command or that command's alias. The words are read only for these,
 * so the quoted text of any other program stays text.
 */
export const COMMAND_STRING_RUNNERS: ReadonlyMap<string, RunnerOptions> = new Map([
  ["tmux new-session", TMUX_NEW_SESSION],
  ["tmux new", TMUX_NEW_SESSION],
  ["tmux new-window", TMUX_NEW_WINDOW],
  ["tmux neww", TMUX_NEW_WINDOW],
  ["tmux split-window", TMUX_SPLIT_WINDOW],
  ["tmux splitw", TMUX_SPLIT_WINDOW],
  ["tmux respawn-pane", TMUX_RESPAWN],
  ["tmux respawnp", TMUX_RESPAWN],
  ["tmux respawn-window", TMUX_RESPAWN],
  ["tmux respawnw", TMUX_RESPAWN],
  ["watch", WATCH],
]);

// tmux's own options before its command, of which these take an argument.
const TMUX_GLOBAL: RunnerOptions = tmuxCommand("cfLST");

const SHELL_SHORT_OPTIONS = /^[-+][A-Za-z]+$/;

// bash's long options that take the next word as their argument.
const SHELL_LONG_OPTIONS_WITH_ARGUMENT: ReadonlySet<string> = new Set(["--init-file", "--rcfile"]);

const NONE: CommandInput = { kind: "none" };

interface Operands {
  readonly words: readonly string[];
  readonly exec: boolean;
}

// The words after a program's options, and whether an option asked it to exec them.
function operands(args: readonly string[], options: RunnerOptions): Operands {
  let exec = false;
  let index = 0;

  while (index < args.length) {
    const word = args[index] ?? "";

    if (word === "--") return { words: args.slice(index + 1), exec };

    if (!word.startsWith("-") || word === "-") return { words: args.slice(index), exec };

    index += 1;

    if (word.startsWith("--")) {
      const name = word.split("=", 1)[0] ?? word;
      exec ||= options.exec.has(name);

      if (options.long.has(name) && !word.includes("=")) index += 1;

      continue;
    }

    for (let at = 1; at < word.length; at += 1) {
      const flag = word.charAt(at);
      exec ||= options.exec.has(`-${flag}`);

      if (options.short.includes(flag)) {
        if (at === word.length - 1) index += 1;

        break;
      }
    }
  }

  return { words: [], exec };
}

// A command line that runs exactly these words, each single-quoted.
function quoted(words: readonly string[]): string {
  return words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

// The command line a runner starts: one word as `sh -c` reads it, or several words
// either executed directly or joined, as the runner does.
function runnerCommands(args: readonly string[], options: RunnerOptions): string[] {
  const { words, exec } = operands(args, options);

  if (words.length === 0) return [];

  if (exec || (options.words === "argv" && words.length > 1)) return [quoted(words)];

  return [words.join(" ")];
}

// tmux runs several commands separated by a `;` word, as in `tmux new -d \; neww 'cmd'`.
function tmuxCommands(args: readonly string[]): string[] {
  const commands: string[][] = [[]];

  for (const word of operands(args, TMUX_GLOBAL).words) {
    if (word === ";") commands.push([]);
    else commands.at(-1)?.push(word);
  }

  return commands.flatMap(([name = "", ...rest]) => {
    const options = COMMAND_STRING_RUNNERS.get(`tmux ${name}`);

    return options === undefined ? [] : runnerCommands(rest, options);
  });
}

// A shell's arguments: a `-c` operand, a script file, or neither, when it reads stdin.
function shellInput(args: readonly string[]): CommandInput {
  let readsCommand = false;
  let readsStdin = false;
  let skipsArgument = false;
  let optionsEnded = false;

  for (const word of args) {
    if (skipsArgument) {
      skipsArgument = false;
      continue;
    }

    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && word.startsWith("--")) {
      skipsArgument = SHELL_LONG_OPTIONS_WITH_ARGUMENT.has(word);
      continue;
    }

    if (optionsEnded || !SHELL_SHORT_OPTIONS.test(word)) {
      if (readsCommand) return { kind: "operand", text: word };

      return readsStdin ? { kind: "stdin" } : NONE;
    }

    if (word.startsWith("-") && word.includes("c")) readsCommand = true;

    if (word.startsWith("-") && word.includes("s")) readsStdin = true;

    // `-o pipefail` and `-O extglob` take the next word as their argument.
    skipsArgument = /[oO]$/.test(word);
  }

  return readsCommand ? NONE : { kind: "stdin" };
}

/** The shell code that a simple command, given its words, runs beyond them. */
export function commandInput(argv: readonly string[]): CommandInput {
  const start = commandStart(argv, isShell);

  if (start.kind === "commandLine") return { kind: "operand", text: start.text };

  const word = argv[start.index] ?? "";
  const args = argv.slice(start.index + 1);
  const name = basename(word);

  if (isShell(word)) return shellInput(args);

  if (word === "eval") return { kind: "operand", text: args.join(" ") };

  if (name === "tmux") return { kind: "runner", commands: tmuxCommands(args) };

  const runner = COMMAND_STRING_RUNNERS.get(name);

  return runner === undefined ? NONE : { kind: "runner", commands: runnerCommands(args, runner) };
}

/**
 * The text that `echo` or `printf` prints, read from its words, with `\n` as a
 * newline. Undefined for any other command.
 */
export function printedText(argv: readonly string[]): string | undefined {
  const [word = "", ...args] = commandArgv(argv);
  const name = basename(word);

  if (name !== "echo" && name !== "printf") return undefined;

  const firstText = name === "echo" ? args.findIndex((arg) => !/^-[neE]+$/.test(arg)) : 0;
  const words = firstText === -1 ? [] : args.slice(firstText);

  return words.join(" ").replaceAll("\\n", "\n");
}
