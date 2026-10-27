// The state the shell command reader in shell-command.ts carries while it reads one
// command string: its scanners, what it has found so far, and what it reads a word into.

import type { Script, Unread, UnreadArgument, WordForm } from "./shell-script.ts";
import type { Cursor } from "./shell-cursor.ts";

export interface HeredocTerminator {
  readonly word: string;
  readonly stripsTabs: boolean;
  // An unquoted delimiter means the body expands substitutions.
  readonly expands: boolean;
  // Set by toCommand to the nested scripts of the shell that reads this heredoc as its
  // script; heredocBodies parses the body into it once the body's lines are read.
  runsIn: Script[] | undefined;
}

// What reading one command has found so far, shared by every scanner of it: how deep
// its scripts nest, the first script a shell runs that it cannot reproduce, and the
// commands with an argument in a word form the reader does not read.
export interface Reading {
  depth: number;
  tooDeep: boolean;
  unreadBy: Unread | undefined;
  readonly unreadArguments: UnreadArgument[];
}

export interface Scanner extends Cursor {
  heredocs: HeredocTerminator[];
  readonly reading: Reading;
}

// What a command gets on stdin that a shell reading stdin runs as its script.
export interface Stdin {
  readonly heredocs: HeredocTerminator[];
  // Here-strings, and the text a literal `echo` or `printf` before the `|` prints.
  readonly literals: Literal[];
}

export interface Literal {
  readonly text: string;
  /** What printed or quoted `text` in a way the reader cannot reproduce. */
  readonly unreadBy: Unread | undefined;
}

export interface Expanded {
  readonly text: string;
  readonly nested: readonly Script[];
  /** The first part of the text in a form the reader does not read, wherever it stands. */
  readonly unread: WordForm | undefined;
}

export interface Word extends Expanded {
  readonly raw: string;
  /**
   * The word's unquoted characters, with each quoted, escaped, or expanded part as `_`,
   * so a brace expansion or a pattern shows only where bash expands it.
   */
  readonly unquoted: string;
}

// A scanner over `text`, sharing `parent`'s reading when it has one.
export function scanner(text: string, parent?: Scanner): Scanner {
  return {
    text,
    index: 0,
    heredocs: [],
    reading: parent?.reading ?? {
      depth: 0,
      tooDeep: false,
      unreadBy: undefined,
      unreadArguments: [],
    },
  };
}
