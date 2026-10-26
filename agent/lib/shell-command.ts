// Reads a shell command string into the commands it runs, for the tool-call guards.
// It is not a full parser. It finds the commands of pipelines and lists, of `( … )`
// and `{ … }` groups, and after reserved words such as `if`, `then`, and `do`. It
// also finds them inside `$( … )`, backtick, and `<( … )` substitutions, whether
// bare, in double quotes, or in an unquoted heredoc body, and in the operand of
// `bash -c`, `sh -c`, `zsh -c`, `eval`, and `env -S`. It reads the command word
// past wrappers such as `sudo -u root`, `command`, and `timeout 5`, and leaves
// `command -v` as the lookup it is. Single-quoted text, and double-quoted
// text outside a substitution, stays one literal word, so a separator or a command
// name inside it is never read as a command. Comments, redirections, and quoted
// heredoc bodies are dropped.

import { commandStart, isShell } from "./command-word.ts";

export { basename, commandArgv, isShell } from "./command-word.ts";

/** One simple command, or a group, with the scripts that run as part of it. */
export interface Command {
  /**
   * The words, with quotes and escapes removed and redirections dropped. A
   * substitution stays in its word as its source text. Empty for a group, and
   * for a `bash -c`, `eval`, or `env -S` whose operand was read into `nested`.
   */
  readonly argv: readonly string[];
  /** Its substitutions, a group's body, or the operand of `bash -c`, `eval`, or `env -S`. */
  readonly nested: readonly Script[];
}

/** Commands joined by `|`, each feeding the next. */
export type Pipeline = readonly Command[];

/** Pipelines joined by `;`, `&`, `&&`, `||`, or newlines. */
export type Script = readonly Pipeline[];

const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/;

const SHELL_SHORT_OPTIONS = /^[-+][A-Za-z]+$/;

// bash's long options that take the next word as their argument.
const SHELL_LONG_OPTIONS_WITH_ARGUMENT: ReadonlySet<string> = new Set(["--init-file", "--rcfile"]);

// Reserved words that may start a command; the command after them still runs.
const LEADING_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "!",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "if",
  "then",
  "until",
  "while",
]);

const WORD_END = /[ \t\r\n;&|()<>]/;

// `?(…)`, `*(…)`, `+(…)`, `@(…)`, and `!(…)` are extended globs, not groups.
const EXTGLOB_PREFIX = /[?*+@!]$/;

const REDIRECTION = /^(?:&>>|&>|<>|<&|>>|>&|>\||<|>)/;

const LIST_OPERATOR = /^(?:;;&|;;|;&|;|&&|\|\||&)/;

// Inside double quotes a backslash escapes only these; before anything else it is literal.
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(["$", "`", '"', "\\", "\n"]);

interface HeredocTerminator {
  readonly word: string;
  readonly stripsTabs: boolean;
  // An unquoted delimiter means the body expands substitutions.
  readonly expands: boolean;
}

interface Scanner {
  readonly text: string;
  index: number;
  heredocs: HeredocTerminator[];
}

// What a script ends at: the end of the text, `)` of a substitution or subshell, or `}` of a brace group.
type Closer = "end" | ")" | "}";

interface Expanded {
  readonly text: string;
  readonly nested: readonly Script[];
}

interface Word extends Expanded {
  readonly raw: string;
}

function scanner(text: string): Scanner {
  return { text, index: 0, heredocs: [] };
}

function at(s: Scanner, offset = 0): string {
  return s.text[s.index + offset] ?? "";
}

function isBlank(char: string): boolean {
  return char === " " || char === "\t" || char === "\r";
}

function skipBlanks(s: Scanner): void {
  while (isBlank(at(s))) s.index += 1;
}

// A backslash-newline joins two lines into one.
function lineContinuation(s: Scanner): number {
  if (at(s) !== "\\") return 0;

  if (at(s, 1) === "\n") return 2;

  return at(s, 1) === "\r" && at(s, 2) === "\n" ? 3 : 0;
}

function backtickBody(s: Scanner): string {
  let body = "";
  s.index += 1;

  while (s.index < s.text.length && at(s) !== "`") {
    const next = at(s, 1);

    if (at(s) === "\\" && (next === "`" || next === "\\" || next === "$")) {
      body += next;
      s.index += 2;
    } else {
      body += at(s);
      s.index += 1;
    }
  }

  s.index = Math.min(s.index + 1, s.text.length);

  return body;
}

// `$(( … ))`: only the substitutions inside it run commands.
function arithmetic(s: Scanner): Script[] {
  const nested: Script[] = [];
  let depth = 0;

  while (s.index < s.text.length) {
    const expansion = substitution(s);

    if (expansion !== undefined) {
      nested.push(expansion);
      continue;
    }

    const char = at(s);
    s.index += 1;

    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (char === ")") {
      if (at(s) === ")") s.index += 1;

      return nested;
    }
  }

  return nested;
}

// A `$( … )` or backtick substitution starting at the scanner, read as a script.
function substitution(s: Scanner): Script | undefined {
  if (at(s) === "`") return parseScript(scanner(backtickBody(s)), "end");

  if (at(s) !== "$" || at(s, 1) !== "(" || at(s, 2) === "(") return undefined;

  s.index += 2;

  return parseScript(s, ")");
}

// Every expansion at the scanner that runs commands: `$(( … ))` arithmetic or a substitution.
function expansions(s: Scanner): Script[] | undefined {
  if (at(s) === "$" && at(s, 1) === "(" && at(s, 2) === "(") {
    s.index += 3;

    return arithmetic(s);
  }

  const script = substitution(s);

  return script === undefined ? undefined : [script];
}

// Reads double-quoted text up to `close`, or a heredoc body to its end when `close` is undefined.
function expandingText(s: Scanner, close: '"' | undefined): Expanded {
  let text = "";
  const nested: Script[] = [];

  while (s.index < s.text.length && at(s) !== close) {
    const start = s.index;
    const found = expansions(s);

    if (found !== undefined) {
      nested.push(...found);
      text += s.text.slice(start, s.index);
    } else if (at(s) === "\\" && DOUBLE_QUOTE_ESCAPES.has(at(s, 1))) {
      if (at(s, 1) !== "\n") text += at(s, 1);
      s.index += 2;
    } else {
      text += at(s);
      s.index += 1;
    }
  }

  return { text, nested };
}

// The text up to the next `close`, with the scanner moved past it.
function upTo(s: Scanner, close: string): string {
  const found = s.text.indexOf(close, s.index);
  const end = found === -1 ? s.text.length : found;
  const text = s.text.slice(s.index, end);
  s.index = Math.min(end + 1, s.text.length);

  return text;
}

// The words of an array assignment `name=( … )`, which are values, not commands.
function arrayElements(s: Scanner): Script[] {
  const nested: Script[] = [];
  s.index += 1;

  while (s.index < s.text.length && at(s) !== ")") {
    if (WORD_END.test(at(s))) s.index += 1;
    else nested.push(...readWord(s).nested);
  }

  s.index = Math.min(s.index + 1, s.text.length);

  return nested;
}

function extglob(s: Scanner): void {
  let depth = 0;

  while (s.index < s.text.length) {
    const char = at(s);
    s.index += char === "\\" ? 2 : 1;

    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;

    if (depth === 0) return;
  }
}

function readWord(s: Scanner): Word {
  const start = s.index;
  let text = "";
  const nested: Script[] = [];

  while (s.index < s.text.length) {
    const char = at(s);
    const next = at(s, 1);
    const continuation = lineContinuation(s);
    const before = s.index;

    if (continuation > 0) {
      s.index += continuation;
    } else if (char === "\\") {
      text += next;
      s.index += 2;
    } else if (char === "'") {
      s.index += 1;
      text += upTo(s, "'");
    } else if (char === "$" && next === "'") {
      s.index += 1;
      text += ansiQuoted(s);
    } else if (char === '"') {
      s.index += 1;
      const quoted = expandingText(s, '"');
      text += quoted.text;
      nested.push(...quoted.nested);
      s.index = Math.min(s.index + 1, s.text.length);
    } else if (char === "(" && ARRAY_ASSIGNMENT.test(text)) {
      nested.push(...arrayElements(s));
      text += s.text.slice(before, s.index);
    } else if (char === "(" && EXTGLOB_PREFIX.test(text)) {
      extglob(s);
      text += s.text.slice(before, s.index);
    } else if (WORD_END.test(char)) {
      break;
    } else {
      const found = expansions(s);

      if (found === undefined) {
        text += char;
        s.index += 1;
      } else {
        nested.push(...found);
        text += s.text.slice(before, s.index);
      }
    }
  }

  return { text, raw: s.text.slice(start, s.index), nested };
}

// `$'…'` ANSI-C quoting: a backslash escapes the next character, so `\'` does not close it.
function ansiQuoted(s: Scanner): string {
  let text = "";
  s.index += 1;

  while (s.index < s.text.length && at(s) !== "'") {
    if (at(s) === "\\") s.index += 1;

    text += at(s);
    s.index += 1;
  }

  s.index = Math.min(s.index + 1, s.text.length);

  return text;
}

// A redirection at the scanner: its target is dropped, but the target's substitutions still run.
function redirection(s: Scanner): Script[] {
  if ((at(s) === "<" || at(s) === ">") && at(s, 1) === "(") {
    s.index += 2;

    return [parseScript(s, ")")];
  }

  if (s.text.startsWith("<<", s.index) && at(s, 2) !== "<") {
    const stripsTabs = at(s, 2) === "-";
    s.index += stripsTabs ? 3 : 2;
    skipBlanks(s);
    const delimiter = readWord(s);
    s.heredocs.push({
      word: delimiter.text,
      stripsTabs,
      expands: !/['"\\]/.test(delimiter.raw),
    });

    return [];
  }

  const operator = s.text.startsWith("<<<", s.index)
    ? "<<<"
    : (REDIRECTION.exec(s.text.slice(s.index))?.[0] ?? at(s));

  s.index += operator.length;
  skipBlanks(s);

  return [...readWord(s).nested];
}

// Skips the heredoc bodies that start on the line after their `<<`, returning the
// substitutions of each body whose delimiter was unquoted.
function heredocBodies(s: Scanner): Script[] {
  const nested: Script[] = [];

  for (const terminator of s.heredocs) {
    const bodyStart = s.index;
    let bodyEnd = s.text.length;

    while (s.index < s.text.length) {
      const newline = s.text.indexOf("\n", s.index);
      const lineEnd = newline === -1 ? s.text.length : newline;
      const line = s.text.slice(s.index, lineEnd).replace(/\r$/, "");
      const candidate = terminator.stripsTabs ? line.replace(/^\t+/, "") : line;

      if (candidate === terminator.word) {
        bodyEnd = s.index;
        s.index = lineEnd + 1;
        break;
      }

      s.index = lineEnd + 1;
    }

    if (terminator.expands) {
      nested.push(...expandingText(scanner(s.text.slice(bodyStart, bodyEnd)), undefined).nested);
    }
  }

  s.heredocs = [];

  return nested;
}

function shellCommandOperand(args: readonly string[]): string | undefined {
  let readsCommand = false;
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

    if (optionsEnded || !SHELL_SHORT_OPTIONS.test(word)) return readsCommand ? word : undefined;

    if (word.startsWith("-") && word.includes("c")) readsCommand = true;

    // `-o pipefail` and `-O extglob` take the next word as their argument.
    skipsArgument = /[oO]$/.test(word);
  }

  return undefined;
}

// The command string that `bash -c '…'`, `sh -c "…"`, `zsh -c …`, `eval …`, or `env -S '…'` runs.
function commandString(argv: readonly string[]): string | undefined {
  const start = commandStart(argv, isShell);

  if (start.kind === "commandLine") return start.text;

  const { index } = start;
  const word = argv[index] ?? "";

  if (isShell(word)) return shellCommandOperand(argv.slice(index + 1));

  if (word === "eval") return argv.slice(index + 1).join(" ");

  return undefined;
}

function toCommand(argv: readonly string[], nested: readonly Script[]): Command {
  const operand = commandString(argv);

  if (operand === undefined) return { argv, nested };

  return { argv: [], nested: [...nested, parseScript(scanner(operand), "end")] };
}

function parseScript(s: Scanner, closer: Closer): Script {
  const script: Pipeline[] = [];
  let pipeline: Command[] = [];
  let argv: string[] = [];
  let nested: Script[] = [];

  const endCommand = (): void => {
    if (argv.length > 0 || nested.length > 0) pipeline.push(toCommand(argv, nested));

    argv = [];
    nested = [];
  };

  const endPipeline = (): void => {
    endCommand();

    if (pipeline.length > 0) script.push(pipeline);

    pipeline = [];
  };

  while (s.index < s.text.length) {
    const char = at(s);
    const continuation = lineContinuation(s);
    const listOperator = LIST_OPERATOR.exec(s.text.slice(s.index))?.[0];

    if (isBlank(char) || continuation > 0) {
      s.index += Math.max(continuation, 1);
    } else if (char === "#") {
      const newline = s.text.indexOf("\n", s.index);
      s.index = newline === -1 ? s.text.length : newline;
    } else if (char === "\n") {
      endPipeline();
      s.index += 1;
      const bodies = heredocBodies(s);

      if (bodies.length > 0) script.push([{ argv: [], nested: bodies }]);
    } else if (char === "|" && at(s, 1) !== "|") {
      endCommand();
      s.index += at(s, 1) === "&" ? 2 : 1;
    } else if (listOperator !== undefined && !(char === "&" && at(s, 1) === ">")) {
      endPipeline();
      s.index += listOperator.length;
    } else if (char === "(" && argv.length > 0 && /^\(\s*\)/.test(s.text.slice(s.index))) {
      // `name()` defines a function. Its name is not a command, and its body follows.
      upTo(s, ")");
      argv = [];
    } else if (char === "(" && at(s, 1) === "(" && argv.length === 0) {
      s.index += 2;
      nested.push(...arithmetic(s));
    } else if (char === "(") {
      s.index += 1;
      nested.push(parseScript(s, ")"));
    } else if (char === ")") {
      s.index += 1;

      if (closer === ")") break;

      // An unmatched `)`, such as a `case` pattern's, ends the command before it.
      endPipeline();
    } else if (char === "<" || char === ">" || char === "&") {
      nested.push(...redirection(s));
    } else {
      const word = readWord(s);
      const startsCommand = argv.length === 0 && nested.length === 0;

      if (startsCommand && closer === "}" && word.raw === "}") break;

      if ((startsCommand || argv[0] === "function") && word.raw === "{") {
        nested.push(parseScript(s, "}"));
      } else if (startsCommand && LEADING_RESERVED_WORDS.has(word.raw)) {
        // The command after the reserved word starts here.
      } else if (/^\d+$/.test(word.raw) && (at(s) === "<" || at(s) === ">")) {
        // A file descriptor number, such as the 2 in `2>&1`.
      } else {
        argv.push(word.text);
        nested.push(...word.nested);
      }
    }
  }

  endPipeline();

  return script;
}

function everyPipeline(script: Script): Pipeline[] {
  return script.flatMap((pipeline) => [
    pipeline,
    ...pipeline.flatMap(({ nested }) => nested.flatMap(everyPipeline)),
  ]);
}

/** Every pipeline the command string runs, those nested inside its commands included. */
export function pipelines(command: string): readonly Pipeline[] {
  return everyPipeline(parseScript(scanner(command), "end"));
}

/** The command and every command nested inside it, at any depth. */
export function withNested(command: Command): readonly Command[] {
  return [command, ...command.nested.flatMap(everyPipeline).flat()];
}
