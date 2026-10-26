// Finds a simple command's command word, past the env assignments, wrappers such
// as `sudo -u root` or `timeout 5`, and their options before it, for the shell
// command reader in shell-command.ts.

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh"]);

const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  ...SHELLS,
  "builtin",
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "node",
  "nohup",
  "setsid",
  "sudo",
  "time",
  "timeout",
]);

interface WrapperOptions {
  /** Short options that take an argument, attached (`-uroot`) or as the next word (`-u root`). */
  readonly short: string;
  /** Long options that take the next word as their argument, unless written `--name=value`. */
  readonly long: ReadonlySet<string>;
  /** The options whose argument is a command line, such as env's `-S`. */
  readonly commandLine: ReadonlySet<string>;
}

// The options that take an argument, per wrapper, so the argument is not read as the command word.
const WRAPPER_OPTIONS: ReadonlyMap<string, WrapperOptions> = new Map([
  ["doas", { short: "aCu", long: new Set<string>(), commandLine: new Set<string>() }],
  [
    "env",
    {
      short: "aCSu",
      long: new Set(["--argv0", "--chdir", "--env0-from", "--split-string", "--unset"]),
      commandLine: new Set(["-S", "--split-string"]),
    },
  ],
  [
    "sudo",
    {
      short: "CDgpRrTtUu",
      long: new Set([
        "--chdir",
        "--chroot",
        "--close-from",
        "--command-timeout",
        "--group",
        "--host",
        "--other-user",
        "--prompt",
        "--role",
        "--type",
        "--user",
      ]),
      commandLine: new Set<string>(),
    },
  ],
]);

const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

function isWrapperWord(word: string): boolean {
  return (
    ENV_ASSIGNMENT.test(word) ||
    COMMAND_WRAPPERS.has(word) ||
    word.startsWith("-") ||
    TIMEOUT_DURATION.test(word)
  );
}

// `command -v` and `command -V` only look a name up, and run nothing.
function looksUp(args: readonly string[]): boolean {
  for (const word of args) {
    if (word === "--" || !word.startsWith("-")) return false;

    if (/[vV]/.test(word)) return true;
  }

  return false;
}

interface Option {
  readonly name: string;
  readonly argument: string | undefined;
  // How many words the option and its argument span.
  readonly words: 1 | 2;
}

// The option word that starts `args`, read by one wrapper's options.
function readOption(options: WrapperOptions, [word = "", next]: readonly string[]): Option {
  if (word.startsWith("--")) {
    const equals = word.indexOf("=");

    if (equals !== -1) {
      return { name: word.slice(0, equals), argument: word.slice(equals + 1), words: 1 };
    }

    return options.long.has(word)
      ? { name: word, argument: next, words: 2 }
      : { name: word, argument: undefined, words: 1 };
  }

  for (let index = 1; index < word.length; index += 1) {
    const flag = word.charAt(index);

    if (!options.short.includes(flag)) continue;

    const attached = word.slice(index + 1);

    return attached === ""
      ? { name: `-${flag}`, argument: next, words: 2 }
      : { name: `-${flag}`, argument: attached, words: 1 };
  }

  return { name: word, argument: undefined, words: 1 };
}

// Where the command starts: the index of its word, or a command line given to a wrapper option.
export type CommandStart =
  | { readonly kind: "word"; readonly index: number }
  | { readonly kind: "commandLine"; readonly text: string };

// Walks past the env assignments, wrappers, and their options before the command
// word. The walk also ends at a word `endsAt` picks, such as a shell.
export function commandStart(
  argv: readonly string[],
  endsAt: (word: string) => boolean,
): CommandStart {
  let wrapper = "";
  let options: WrapperOptions | undefined;
  let index = 0;

  while (index < argv.length) {
    const word = argv[index] ?? "";

    if (options !== undefined && word.startsWith("-")) {
      const option = readOption(options, argv.slice(index));
      index += option.words;

      // The wrapper reads the split words, and the words after them, as its own arguments.
      if (options.commandLine.has(option.name)) {
        return {
          kind: "commandLine",
          text: [wrapper, option.argument ?? "", ...argv.slice(index)].join(" "),
        };
      }

      continue;
    }

    if (endsAt(word) || !isWrapperWord(word)) return { kind: "word", index };

    if (word === "command" && looksUp(argv.slice(index + 1))) return { kind: "word", index };

    wrapper = word;
    options = WRAPPER_OPTIONS.get(word);
    index += 1;
  }

  return { kind: "word", index };
}

export function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Whether the word names bash, sh, or zsh, by name or by path. */
export function isShell(word: string): boolean {
  return SHELLS.has(basename(word));
}

/**
 * The words from the command word on, without the env assignments, wrappers such
 * as `timeout 5`, `sudo -u root`, or `bash`, and flags before it. Empty when no
 * word is left, and when the command is a split string, as in `env -S '…'`, which
 * `pipelines` reads as a nested script.
 */
export function commandArgv(argv: readonly string[]): readonly string[] {
  const start = commandStart(argv, () => false);

  return start.kind === "word" ? argv.slice(start.index) : [];
}
