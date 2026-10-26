// Shell splitting shared by the tool-call guards. It is a word-level reading of a
// command, not a full parser: it honors quotes, escapes, comments, and heredocs, so
// a separator or a command inside a quoted string is never read as a command.

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  "bash",
  "env",
  "exec",
  "nice",
  "node",
  "nohup",
  "setsid",
  "sh",
  "time",
  "timeout",
  "zsh",
]);

// Shells whose `-c` operand is itself a command to read.
const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh"]);

const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

// Characters that end an unquoted heredoc delimiter.
const DELIMITER_END = /[\s;&|()<>]/;

// Inside double quotes a backslash escapes only these; before anything else it is literal.
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(["$", "`", '"', "\\", "\n"]);

interface HeredocTerminator {
  readonly word: string;
  readonly stripsTabs: boolean;
}

interface Quoted {
  readonly text: string;
  readonly end: number;
}

function singleQuoted(command: string, start: number): Quoted {
  const close = command.indexOf("'", start + 1);
  const end = close === -1 ? command.length : close + 1;

  return { text: command.slice(start + 1, close === -1 ? end : close), end };
}

function doubleQuoted(command: string, start: number): Quoted {
  let text = "";
  let index = start + 1;

  while (index < command.length && command[index] !== '"') {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (char === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
      if (next !== "\n") text += next;
      index += 2;
    } else {
      text += char;
      index += 1;
    }
  }

  return { text, end: Math.min(index + 1, command.length) };
}

// The delimiter after `<<` or `<<-`, with its quotes removed, and the index after it.
function heredocDelimiter(command: string, start: number): Quoted {
  let index = start;
  let text = "";

  while (command[index] === " " || command[index] === "\t") index += 1;

  while (index < command.length && !DELIMITER_END.test(command[index] ?? "")) {
    const char = command[index];

    if (char === "'" || char === '"') {
      const quoted = char === "'" ? singleQuoted(command, index) : doubleQuoted(command, index);
      text += quoted.text;
      index = quoted.end;
    } else {
      text += char;
      index += 1;
    }
  }

  return { text, end: index };
}

// The index just past the heredoc bodies that start at `start`, the first line after the `<<`.
function afterHeredocBodies(
  command: string,
  start: number,
  terminators: readonly HeredocTerminator[],
): number {
  let index = start;

  for (const terminator of terminators) {
    while (index < command.length) {
      const newline = command.indexOf("\n", index);
      const lineEnd = newline === -1 ? command.length : newline;
      const line = command.slice(index, lineEnd).replace(/\r$/, "");
      const candidate = terminator.stripsTabs ? line.replace(/^\t+/, "") : line;

      index = lineEnd + 1;

      if (candidate === terminator.word) break;
    }
  }

  return index;
}

// `<<` or `<<-` starts a heredoc; `<<<` is a here-string.
function isHeredoc(command: string, index: number): boolean {
  return (
    command.startsWith("<<", index) && command[index - 1] !== "<" && command[index + 2] !== "<"
  );
}

function isSeparator(command: string, index: number): boolean {
  const char = command[index];

  if (char === ";" || char === "|" || char === "\n") return true;

  if (char !== "&") return false;

  // `&` next to `<` or `>` is a redirection such as `2>&1` or `&>log`, not a separator.
  const previous = command[index - 1];

  return previous !== "<" && previous !== ">" && command[index + 1] !== ">";
}

/** The words of each simple command, read with quotes, escapes, comments, and heredocs. */
function splitCommands(command: string): string[][] {
  const commands: string[][] = [];
  let argv: string[] = [];
  let word = "";
  let inWord = false;
  let heredocs: HeredocTerminator[] = [];
  let index = 0;

  const endWord = (): void => {
    if (inWord) argv.push(word);
    word = "";
    inWord = false;
  };

  const endCommand = (): void => {
    endWord();

    if (argv.length > 0) commands.push(argv);

    argv = [];
  };

  while (index < command.length) {
    const char = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (char === "\\") {
      // A backslash before a newline joins the lines; before anything else it quotes that character.
      if (next === "\n") index += 2;
      else if (next === "\r" && command[index + 2] === "\n") index += 3;
      else {
        word += next;
        inWord = true;
        index += 2;
      }
    } else if (char === "'" || char === '"') {
      const quoted = char === "'" ? singleQuoted(command, index) : doubleQuoted(command, index);
      word += quoted.text;
      inWord = true;
      index = quoted.end;
    } else if (char === "#" && !inWord) {
      const newline = command.indexOf("\n", index);
      index = newline === -1 ? command.length : newline;
    } else if (isHeredoc(command, index)) {
      endWord();
      const stripsTabs = command[index + 2] === "-";
      const delimiter = heredocDelimiter(command, index + (stripsTabs ? 3 : 2));
      heredocs.push({ word: delimiter.text, stripsTabs });
      index = delimiter.end;
    } else if (isSeparator(command, index)) {
      endCommand();
      index += 1;

      if (char === "\n" && heredocs.length > 0) {
        index = afterHeredocBodies(command, index, heredocs);
        heredocs = [];
      }
    } else if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
    } else {
      word += char;
      inWord = true;
      index += 1;
    }
  }

  endCommand();

  return commands;
}

function isWrapperWord(word: string): boolean {
  return (
    ENV_ASSIGNMENT.test(word) ||
    COMMAND_WRAPPERS.has(word) ||
    word.startsWith("-") ||
    TIMEOUT_DURATION.test(word)
  );
}

/**
 * The index of the command word: the first word that is not an env assignment,
 * a wrapper such as `timeout` or `bash`, a flag, or a timeout duration. It is
 * `-1` when every word is one of those.
 */
export function commandIndex(argv: readonly string[]): number {
  return argv.findIndex((word) => !isWrapperWord(word));
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

// The command string a shell runs from `-c`, given the words after the shell's name.
function shellCommandOperand(args: readonly string[]): string | undefined {
  let readsCommand = false;
  let skipsArgument = false;
  let optionsEnded = false;

  for (const word of args) {
    if (skipsArgument) {
      skipsArgument = false;
    } else if (!optionsEnded && word === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && /^[-+][A-Za-z]+$/.test(word)) {
      if (word.startsWith("-") && word.includes("c")) readsCommand = true;
      // `-o pipefail` and `-O extglob` take the next word as their argument.
      skipsArgument = /[oO]$/.test(word);
    } else if (!optionsEnded && word.startsWith("--")) {
      // A long option such as `--login` or `--norc`.
    } else {
      return readsCommand ? word : undefined;
    }
  }

  return undefined;
}

// The command string that `bash -c '…'`, `sh -c "…"`, `zsh -c …`, or `eval …` runs, if any.
function innerCommand(argv: readonly string[]): string | undefined {
  for (const [index, word] of argv.entries()) {
    if (SHELLS.has(basename(word))) return shellCommandOperand(argv.slice(index + 1));

    if (word === "eval") return argv.slice(index + 1).join(" ");

    if (!isWrapperWord(word)) return undefined;
  }

  return undefined;
}

/**
 * The words of each simple command, in order. It splits on `&&`, `||`, `;`, `|`,
 * `&`, and newlines outside quotes, drops comments and heredoc bodies, joins line
 * continuations, and removes quotes and escapes from each word. The command string
 * of `bash -c`, `sh -c`, `zsh -c`, or `eval` is read the same way, in its place.
 */
export function simpleCommands(command: string): readonly (readonly string[])[] {
  return splitCommands(command).flatMap((argv) => {
    const inner = innerCommand(argv);

    return inner === undefined ? [argv] : simpleCommands(inner);
  });
}
