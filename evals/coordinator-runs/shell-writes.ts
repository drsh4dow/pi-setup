// Reads what a bash command writes and which chunk CLI calls it makes, statement by statement, the
// way the shell would resolve its paths, without running it.

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
  commandIndices,
  commandName,
  CUT,
  simpleCommands,
  statements,
  withoutHeredocBodies,
  type Word,
} from "./shell.ts";

/** A chunk CLI call: the state folder it names, when the command says, and its arguments after it. */
export interface ChunkCliCall {
  readonly state: string | undefined;
  readonly args: string;
}

/** One statement of a bash command, read as the shell would run it. */
export interface ShellStatement {
  /**
   * The statement with the variables the command set before it expanded, keeping the body of a
   * heredoc it opens.
   */
  readonly text: string;
  /** The absolute paths it writes: redirection targets, `tee` files, `sed -i` files, and `cp` or `mv` destinations. */
  readonly writes: readonly string[];
  /** The chunk CLI calls it makes. */
  readonly chunkCli: readonly ChunkCliCall[];
}

const CHUNK_CLI = "chunk.ts";

const STATE_VARIABLE = "IMPLEMENT_CHUNK_STATE";

/** `$NAME` or `${NAME}`, outside single quotes, replaced by the value the command gave it. */
function expand(text: string, variables: ReadonlyMap<string, string>): string {
  let out = "";
  let inDouble = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (char === "\\") {
      out += text.slice(index, index + 2);
      index++;
    } else if (char === "'" && !inDouble) {
      const close = text.indexOf("'", index + 1);
      const end = close < 0 ? text.length : close + 1;

      out += text.slice(index, end);
      index = end - 1;
    } else if (char === '"') {
      inDouble = !inDouble;
      out += char;
    } else if (char === "$") {
      const name = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(text.slice(index));
      const value = name && variables.get(name[1] ?? name[2]);

      if (name && value !== undefined) {
        out += value;
        index += name[0].length - 1;
      } else out += char;
    } else out += char;
  }

  return out;
}

/**
 * The path a word names, absolute, or none when the shell would expand it into something
 * unknown, or when it is relative and the directory it resolves from is unknown.
 */
function pathOf(text: string, cwd: string | undefined): string | undefined {
  if (text === "" || /[$`*?]/.test(text)) return undefined;

  const path = text === "~" || text.startsWith("~/") ? homedir() + text.slice(1) : text;

  if (isAbsolute(path)) return resolve(path);

  return cwd === undefined ? undefined : resolve(cwd, path);
}

/** Where `cd <arg>` goes: home with no argument, and somewhere unknown for `cd -`. */
function cdTarget(arg: string | undefined, directory: string | undefined): string | undefined {
  if (arg === undefined) return homedir();

  return arg === "-" ? undefined : pathOf(arg, directory);
}

const isAssignment = (word: Word) => /^[A-Za-z_]\w*=/.test(word.text);

/**
 * Sets each `NAME=value` word's variable. A value the shell computes, such as `$(mktemp -d)`,
 * keeps its `$`, so a path built from it is left out.
 */
function assign(variables: Map<string, string>, words: readonly Word[]) {
  for (const word of words.filter(isAssignment)) {
    const equals = word.text.indexOf("=");

    variables.set(word.text.slice(0, equals), word.text.slice(equals + 1));
  }
}

/** A word a command writes to, with where it ends in the statement. */
type Target = Pick<Word, "text" | "end">;

/** The files one simple command writes, from the arguments after its command word. */
function writtenBy(name: string, args: readonly Word[]): Target[] {
  const positional = args.filter((arg) => !arg.text.startsWith("-"));

  if (name === "tee") return positional;

  if (name === "sed" && args.some((arg) => /^-[a-zA-Z]*i|^--in-place/.test(arg.text))) {
    const files: Word[] = [];
    let scripted = false;

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];

      if (["-e", "-f", "--expression", "--file"].includes(arg.text)) {
        scripted = true;
        index++;
      } else if (!arg.text.startsWith("-")) files.push(arg);
    }

    return scripted ? files : files.slice(1);
  }

  if (name === "cp" || name === "mv") {
    const flag = args.findIndex((arg) => /^(?:-t|--target-directory)(?:=|$)/.test(arg.text));
    const arg = args[flag];

    if (arg === undefined) return positional.length >= 2 ? positional.slice(-1) : [];

    const equals = arg.text.indexOf("=");

    return equals < 0
      ? args.slice(flag + 1, flag + 2)
      : [{ text: arg.text.slice(equals + 1), end: arg.end }];
  }

  return [];
}

/** The state folder a chunk CLI call names: its `--state`, else the variable it runs with. */
function chunkCliCall(
  words: readonly Word[],
  at: number,
  variables: ReadonlyMap<string, string>,
  directory: string | undefined,
): ChunkCliCall {
  const args = words.slice(at + 1).map((word) => word.text);
  const flag = args.findIndex((arg) => arg === "--state" || arg.startsWith("--state="));

  const prefix = words
    .slice(0, at)
    .find((word) => word.text.startsWith(`${STATE_VARIABLE}=`))
    ?.text.slice(STATE_VARIABLE.length + 1);

  let state = prefix ?? variables.get(STATE_VARIABLE);
  let rest = args;

  if (flag >= 0) {
    const inline = args[flag] !== "--state";

    state = inline ? args[flag].slice("--state=".length) : args[flag + 1];
    rest = args.filter((_, index) => index !== flag && (inline || index !== flag + 1));
  }

  return {
    state: state === undefined ? undefined : pathOf(state, directory),
    args: rest.join(" "),
  };
}

/**
 * The command's statements as the shell would run them from `cwd`: what each writes, and the
 * chunk CLI calls it makes. Variables assigned earlier in the command are expanded, and `cd`
 * moves the directory later relative paths resolve from; after a `cd` to a directory the command
 * does not say, relative paths are left out. A path that holds a variable the command never set,
 * a command substitution, or a glob is left out, and so is the last word of a command codemode
 * cut short.
 */
export function shellStatements(command: string, cwd: string): ShellStatement[] {
  const cut = CUT.test(command);
  const variables = new Map<string, string>([["HOME", homedir()]]);
  const all = statements(command.replace(CUT, ""));
  let directory: string | undefined = cwd;

  return all.map((statement, statementIndex) => {
    const text = expand(statement, variables);
    const shell = withoutHeredocBodies(text);
    const writes: string[] = [];
    const chunkCli: ChunkCliCall[] = [];
    const lastEnd = shell.trimEnd().length;

    const write = (target: Target) => {
      if (cut && statementIndex === all.length - 1 && target.end >= lastEnd) return;

      const path = pathOf(target.text, directory);

      if (path !== undefined && !/^\/(?:dev|proc)\//.test(path)) writes.push(path);
    };

    for (const words of simpleCommands(shell)) {
      for (const word of words) {
        if (word.redirect === undefined || !word.redirect.includes(">")) continue;

        // `2>&1` and `>&-` duplicate or close a descriptor and write no file.
        if (word.redirect.endsWith("&") && /^(?:\d+|-)$/.test(word.text)) continue;

        write(word);
      }

      const plain = words.filter((word) => word.redirect === undefined);
      const at = commandIndices(plain).at(-1);

      if (at === undefined) {
        // A statement of assignments only sets variables for the rest of the command.
        assign(variables, plain);
        continue;
      }

      const name = commandName(plain[at]);
      const argWords = plain.slice(at + 1);

      if (name === "export" || name === "declare" || name === "local") {
        assign(variables, argWords);
      } else if (name === "cd") {
        directory = cdTarget(argWords[0]?.text, directory);
      } else if (name === CHUNK_CLI) {
        chunkCli.push(chunkCliCall(plain, at, variables, directory));
      } else {
        for (const target of writtenBy(name, argWords)) write(target);
      }
    }

    return { text, writes, chunkCli };
  });
}
