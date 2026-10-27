// Reads a shell command string into the commands it runs, for the tool-call guards.
// It is not a full parser. It finds the commands of pipelines, lists, groups, and
// `case` clauses, and the command after a reserved word such as `if` or `do`. It also
// reads `$( … )`, backtick, and `<( … )` substitutions, bare, in double quotes, or in an
// unquoted heredoc body. It reads the operand of `bash -c`, `eval`, and `env -S`, the
// command line a runner in command-input.ts starts, such as `tmux new-session`, and a
// heredoc, here-string, or literal `echo` or `printf` fed to a shell that reads stdin.
// Any other quoted text stays one literal word, so a command name in it is never read
// as a command. Comments, redirections, and other heredoc bodies are dropped. It
// follows at most MAX_NESTING levels of nesting.

import { commandInput, echoedText } from "./command-input.ts";
import { flatWords } from "./flat-words.ts";
import type { Printed } from "./printf.ts";
import {
  WORD_END,
  ansiQuoted,
  at,
  atWord,
  backtickBody,
  LEADING_RESERVED_WORDS,
  extglob,
  isBlank,
  lineContinuation,
  skipBlanks,
  skipCaseSeparators,
  upTo,
  type Cursor,
} from "./shell-cursor.ts";

export { basename, commandArgv, isShell } from "./command-word.ts";

/** One simple command, or a group, with the scripts that run as part of it. */
export interface Command {
  /**
   * The words, with quotes and escapes removed and redirections dropped. A
   * substitution stays in its word as its source text. Empty for a group, and
   * for a `bash -c`, `eval`, or `env -S` whose operand was read into `nested`.
   */
  readonly argv: readonly string[];
  /** Its substitutions, group and `case` bodies, operands, runner commands, and literal stdin. */
  readonly nested: readonly Script[];
}

/** Commands joined by `|`, each feeding the next. */
export type Pipeline = readonly Command[];

/** Pipelines joined by `;`, `&`, `&&`, `||`, or newlines. */
export type Script = readonly Pipeline[];

/** The deepest nesting of scripts inside scripts that the reader follows. */
export const MAX_NESTING = 64;

const ARRAY_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/;

// `?(…)`, `*(…)`, `+(…)`, `@(…)`, and `!(…)` are extended globs, not groups.
const EXTGLOB_PREFIX = /[?*+@!]$/;

const REDIRECTION = /^(?:&>>|&>|<>|<&|>>|>&|>\||<|>)/;

const LIST_OPERATOR = /^(?:;;&|;;|;&|;|&&|\|\||&)/;

// The operators that end a `case` clause.
const CLAUSE_END: ReadonlySet<string> = new Set([";;", ";&", ";;&"]);

// Inside double quotes a backslash escapes only these; before anything else it is literal.
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(["$", "`", '"', "\\", "\n"]);

interface HeredocTerminator {
  readonly word: string;
  readonly stripsTabs: boolean;
  // An unquoted delimiter means the body expands substitutions.
  readonly expands: boolean;
  // Set by toCommand to the nested scripts of the shell that reads this heredoc as its
  // script; heredocBodies parses the body into it once the body's lines are read.
  runsIn: Script[] | undefined;
}

// What reading one command has found so far, shared by every scanner of it: how deep
// its scripts nest, and whether a shell runs a printf's output that printf.ts cannot
// reproduce.
interface Reading {
  depth: number;
  tooDeep: boolean;
  unreadPrintf: boolean;
}

interface Scanner extends Cursor {
  heredocs: HeredocTerminator[];
  readonly reading: Reading;
}

// What a script ends at: the end of the text, `)` of a substitution or subshell, `}` of
// a brace group, or the `;;` or `esac` that ends a `case` clause.
type Closer = "end" | ")" | "}" | "clause";

type MutableCommand = Command & { readonly nested: Script[] };

// What a command gets on stdin that a shell reading stdin runs as its script.
interface Stdin {
  readonly heredocs: HeredocTerminator[];
  // Here-strings, and the text a literal `echo` or `printf` before the `|` prints.
  readonly literals: Printed[];
}

interface Expanded {
  readonly text: string;
  readonly nested: readonly Script[];
}

interface Word extends Expanded {
  readonly raw: string;
}

// A scanner over `text`, sharing `parent`'s reading when it has one.
function scanner(text: string, parent?: Scanner): Scanner {
  return {
    text,
    index: 0,
    heredocs: [],
    reading: parent?.reading ?? { depth: 0, tooDeep: false, unreadPrintf: false },
  };
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
  if (at(s) === "`") return parseScript(scanner(backtickBody(s), s), "end");

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

// A redirection at the scanner. It returns the scripts its target runs, and adds a
// heredoc or here-string to `stdin`; any other target is dropped.
function redirection(s: Scanner, stdin: Stdin): Script[] {
  if ((at(s) === "<" || at(s) === ">") && at(s, 1) === "(") {
    s.index += 2;

    return [parseScript(s, ")")];
  }

  if (s.text.startsWith("<<", s.index) && at(s, 2) !== "<") {
    const stripsTabs = at(s, 2) === "-";
    s.index += stripsTabs ? 3 : 2;
    skipBlanks(s);
    const delimiter = readWord(s);

    const heredoc: HeredocTerminator = {
      word: delimiter.text,
      stripsTabs,
      expands: !/['"\\]/.test(delimiter.raw),
      runsIn: undefined,
    };

    s.heredocs.push(heredoc);
    stdin.heredocs.push(heredoc);

    return [];
  }

  const operator = s.text.startsWith("<<<", s.index)
    ? "<<<"
    : (REDIRECTION.exec(s.text.slice(s.index))?.[0] ?? at(s));

  s.index += operator.length;
  skipBlanks(s);
  const target = readWord(s);

  if (operator === "<<<") stdin.literals.push({ text: target.text, readable: true });

  return [...target.nested];
}

// Skips the heredoc bodies that start on the line after their `<<`. It reads a body
// that a shell runs as a script into that shell's command, and returns the
// substitutions of each body whose delimiter was unquoted, which run before any shell
// reads the body.
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

    const body = scanner(s.text.slice(bodyStart, bodyEnd), s);

    if (terminator.runsIn !== undefined) terminator.runsIn.push(parseScript(body, "end"));

    if (terminator.expands) nested.push(...expandingText({ ...body, index: 0 }, undefined).nested);
  }

  s.heredocs = [];

  return nested;
}

function toCommand(
  s: Scanner,
  argv: readonly string[],
  nested: readonly Script[],
  stdin: Stdin,
): MutableCommand {
  const input = commandInput(argv);

  switch (input.kind) {
    case "none":
      return { argv, nested: [...nested] };
    case "operand":
      return { argv: [], nested: [...nested, parseScript(scanner(input.text, s), "end")] };
    case "runner":
      return {
        argv,
        nested: [...nested, ...input.commands.map((line) => parseScript(scanner(line, s), "end"))],
      };
    case "stdin": {
      const command = { argv, nested: [...nested] };

      // heredocBodies fills these once the bodies' lines are read.
      for (const heredoc of stdin.heredocs) heredoc.runsIn = command.nested;

      for (const { text, readable } of stdin.literals) {
        s.reading.unreadPrintf ||= !readable;
        command.nested.push(parseScript(scanner(text, s), "end"));
      }

      return command;
    }

    default: {
      const unexpected: never = input;

      return unexpected;
    }
  }
}

// A clause's patterns, up to and past its `)`. They are words, never commands.
function casePatterns(s: Scanner): Script[] {
  const nested: Script[] = [];

  while (s.index < s.text.length && at(s) !== ")") {
    if (WORD_END.test(at(s))) s.index += 1;
    else nested.push(...readWord(s).nested);
  }

  s.index = Math.min(s.index + 1, s.text.length);

  return nested;
}

// The rest of a `case` statement after its `case` word, through `esac`: the
// substitutions of its subject and patterns, and each clause's body as a script.
function caseStatement(s: Scanner): Script[] {
  skipBlanks(s);
  const nested: Script[] = [...readWord(s).nested];
  skipCaseSeparators(s);

  if (atWord(s, "in")) s.index += "in".length;

  while (s.index < s.text.length) {
    skipCaseSeparators(s);

    if (atWord(s, "esac")) {
      s.index += "esac".length;
      break;
    }

    if (at(s) === "(") s.index += 1;

    nested.push(...casePatterns(s), parseScript(s, "clause"));
  }

  return nested;
}

function parseScript(s: Scanner, closer: Closer): Script {
  // Past the limit, mark the command too deep and skip the rest of it.
  if (s.reading.depth > MAX_NESTING) {
    s.reading.tooDeep = true;
    s.index = s.text.length;

    return [];
  }

  s.reading.depth += 1;

  const script: Pipeline[] = [];
  let pipeline: MutableCommand[] = [];
  let argv: string[] = [];
  let nested: Script[] = [];
  let stdin: Stdin = { heredocs: [], literals: [] };

  const endCommand = (): void => {
    if (argv.length > 0 || nested.length > 0) pipeline.push(toCommand(s, argv, nested, stdin));

    argv = [];
    nested = [];
    stdin = { heredocs: [], literals: [] };
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
      const printed = echoedText(pipeline.at(-1)?.argv ?? []);

      if (printed !== undefined) stdin.literals.push(printed);
    } else if (listOperator !== undefined && !(char === "&" && at(s, 1) === ">")) {
      endPipeline();
      s.index += listOperator.length;

      if (closer === "clause" && CLAUSE_END.has(listOperator)) break;
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

      // An unmatched `)` ends the command before it.
      endPipeline();
    } else if (char === "<" || char === ">" || char === "&") {
      nested.push(...redirection(s, stdin));
    } else {
      const start = s.index;
      const word = readWord(s);
      const startsCommand = argv.length === 0 && nested.length === 0;

      if (startsCommand && closer === "}" && word.raw === "}") break;

      if (startsCommand && closer === "clause" && word.raw === "esac") {
        s.index = start;
        break;
      }

      if ((startsCommand || argv[0] === "function") && word.raw === "{") {
        nested.push(parseScript(s, "}"));
      } else if (startsCommand && word.raw === "case") {
        nested.push(...caseStatement(s));
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
  s.reading.depth -= 1;

  return script;
}

function everyPipeline(script: Script): Pipeline[] {
  return script.flatMap((pipeline) => [
    pipeline,
    ...pipeline.flatMap(({ nested }) => nested.flatMap(everyPipeline)),
  ]);
}

/** A command string read into every pipeline it runs, or found nested past MAX_NESTING. */
export type ParsedCommand =
  | {
      readonly kind: "pipelines";
      readonly pipelines: readonly Pipeline[];
      /** Whether a shell runs as its script what a printf prints that printf.ts cannot reproduce. */
      readonly unreadPrintf: boolean;
    }
  | { readonly kind: "too-deep"; readonly limit: number };

function readScript(command: string) {
  const s = scanner(command);
  const all = everyPipeline(parseScript(s, "end"));

  return { all, tooDeep: s.reading.tooDeep, unreadPrintf: s.reading.unreadPrintf };
}

export function parseCommand(command: string): ParsedCommand {
  const { all, tooDeep, unreadPrintf } = readScript(command);

  if (tooDeep) return { kind: "too-deep", limit: MAX_NESTING };

  return { kind: "pipelines", pipelines: all, unreadPrintf };
}

/**
 * Every pipeline the command string runs, those nested inside its commands included.
 * Past MAX_NESTING it also reads the text flat with quotes removed, so a guard still
 * sees the command words of the part it could not parse.
 */
export function pipelines(command: string): readonly Pipeline[] {
  const { all, tooDeep } = readScript(command);

  if (!tooDeep) return all;

  return [...all, ...flatWords(command).map((argv) => [{ argv, nested: [] }])];
}

/** The command and every command nested inside it, at any depth. */
export function withNested(command: Command): readonly Command[] {
  return [command, ...command.nested.flatMap(everyPipeline).flat()];
}
