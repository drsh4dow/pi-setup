// Reads shell text flat, without nesting, for the fallback of `pipelines()` in
// shell-command.ts past MAX_NESTING, so a guard still sees the command words of the
// part the structured reader could not parse.

import { LEADING_RESERVED_WORDS } from "./shell-cursor.ts";

// flatWords splits at separators, openers, and closers, and removes quotes and backslashes.
const FLAT_SEPARATOR = /[\n;&|()`{}<>]|\$\(/;

const FLAT_QUOTING = /\\(.)|\$?['"]/g;

const LINE_CONTINUATION = /\\\n/g;

/**
 * The text read without nesting: its line continuations joined, each part between
 * separators split at blanks, past any leading reserved word such as `then`, and read
 * again split at its quotes, so `bash -c 'pi-subagent …'` also puts pi-subagent first.
 */
export function flatWords(text: string): string[][] {
  const parts = text.replaceAll(LINE_CONTINUATION, "").split(FLAT_SEPARATOR);
  const quotedParts = parts.flatMap((part) => (/['"]/.test(part) ? part.split(/['"]/) : []));

  return [...parts, ...quotedParts].flatMap((part) => {
    const words = part.split(/\s+/).map((word) => word.replaceAll(FLAT_QUOTING, "$1"));
    const kept = words.filter((word) => word !== "");
    const command = kept.findIndex((word) => !LEADING_RESERVED_WORDS.has(word));

    return command === -1 ? [] : [kept.slice(command)];
  });
}
