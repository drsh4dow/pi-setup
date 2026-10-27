// The commands a shell command string runs, as shell-command.ts reads them, and how
// the reader reports a command it could not read.

import type { Printer } from "./command-input.ts";

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

/**
 * A word form the reader cannot reproduce: an ANSI-C quoted `$'…'` escape that
 * shell-cursor.ts does not decode, a locale-quoted `$"…"` string, a brace expansion
 * such as `{a,b}` or `{1..3}`, `$[…]` arithmetic, or, in a command name or a script a
 * shell runs, an unquoted pathname pattern such as `*`, `?`, or `[…]`.
 */
export type WordForm = "ansi-c" | "locale" | "brace" | "dollar-bracket" | "pattern";

/**
 * What printed or quoted a shell's script in a way the reader cannot reproduce: an
 * echo or printf feature printf.ts does not read, or a word form the reader does not read.
 */
export type Unread = Printer | WordForm;

/** A command with an argument the reader could not read, and the form of that argument. */
export interface UnreadArgument {
  readonly argv: readonly string[];
  readonly form: WordForm;
}

/** A command string read into every pipeline it runs, or found nested past MAX_NESTING in shell-command.ts. */
export type ParsedCommand =
  | {
      readonly kind: "pipelines";
      readonly pipelines: readonly Pipeline[];
      /** What printed or quoted a script a shell runs in a way the reader cannot reproduce. */
      readonly unreadBy: Unread | undefined;
      /** Commands with an argument the reader could not read, for the guard to judge. */
      readonly unreadArguments: readonly UnreadArgument[];
    }
  | { readonly kind: "too-deep"; readonly limit: number };

// Every pipeline of the script, those nested inside its commands included.
export function everyPipeline(script: Script): Pipeline[] {
  return script.flatMap((pipeline) => [
    pipeline,
    ...pipeline.flatMap(({ nested }) => nested.flatMap(everyPipeline)),
  ]);
}

/** The command and every command nested inside it, at any depth. */
export function withNested(command: Command): readonly Command[] {
  return [command, ...command.nested.flatMap(everyPipeline).flat()];
}
