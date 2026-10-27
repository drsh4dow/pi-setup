// Character-level reads over shell text, for the shell command reader in
// shell-command.ts: quoting, line continuations, blanks, comments, the
// separators between the parts of a `case` statement, and the reserved words
// that may start a command.

/** Shell text and the reader's position in it. */
export interface Cursor {
  readonly text: string;
  index: number;
}

export const WORD_END = /[ \t\r\n;&|()<>]/;

/** Reserved words that may start a command; the command after them still runs. */
export const LEADING_RESERVED_WORDS: ReadonlySet<string> = new Set([
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

export function at(s: Cursor, offset = 0): string {
  return s.text[s.index + offset] ?? "";
}

export function isBlank(char: string): boolean {
  return char === " " || char === "\t" || char === "\r";
}

export function skipBlanks(s: Cursor): void {
  while (isBlank(at(s))) s.index += 1;
}

// A backslash-newline joins two lines into one.
export function lineContinuation(s: Cursor): number {
  if (at(s) !== "\\") return 0;

  if (at(s, 1) === "\n") return 2;

  return at(s, 1) === "\r" && at(s, 2) === "\n" ? 3 : 0;
}

export function backtickBody(s: Cursor): string {
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

// The text up to the next `close`, with the cursor moved past it.
export function upTo(s: Cursor, close: string): string {
  const found = s.text.indexOf(close, s.index);
  const end = found === -1 ? s.text.length : found;
  const text = s.text.slice(s.index, end);
  s.index = Math.min(end + 1, s.text.length);

  return text;
}

export function extglob(s: Cursor): void {
  let depth = 0;

  while (s.index < s.text.length) {
    const char = at(s);
    s.index += char === "\\" ? 2 : 1;

    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;

    if (depth === 0) return;
  }
}

// The one-character escapes of `$'…'`, and the character bash decodes each to.
const ANSI_C_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["a", "\x07"],
  ["b", "\b"],
  ["e", "\x1b"],
  ["E", "\x1b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
  ["'", "'"],
  ['"', '"'],
  ["?", "?"],
]);

// An octal escape of one to three digits, or a hex escape of one or two.
const ANSI_C_NUMBER = /^(?:[0-7]{1,3}|x[0-9A-Fa-f]{1,2})/;

// Escapes whose output depends on the locale or that are not read here: `\u`, `\U`, `\c`.
const ANSI_C_UNREAD = /^[uUc]/;

/** A `$'…'` word's text as bash decodes it, or `readable: false` when the guard cannot. */
export interface AnsiQuoted {
  readonly text: string;
  readonly readable: boolean;
}

// `$'…'` ANSI-C quoting, from its `'`. Bash decodes the escapes in ANSI_C_ESCAPES and
// ANSI_C_NUMBER and keeps any other backslash as written. A number that decodes to
// NUL, which ends the word, or above 0x7F, a byte rather than a character, is unread.
export function ansiQuoted(s: Cursor): AnsiQuoted {
  let text = "";
  let readable = true;
  s.index += 1;

  while (s.index < s.text.length && at(s) !== "'") {
    const rest = s.text.slice(s.index + 1, s.index + 5);
    const escaped = ANSI_C_ESCAPES.get(at(s, 1));
    const number = ANSI_C_NUMBER.exec(rest)?.[0];

    if (at(s) !== "\\") {
      text += at(s);
      s.index += 1;
    } else if (escaped !== undefined) {
      text += escaped;
      s.index += 2;
    } else if (number !== undefined) {
      const code = number.startsWith("x")
        ? Number.parseInt(number.slice(1), 16)
        : Number.parseInt(number, 8);

      readable &&= code > 0 && code < 0x80;
      text += String.fromCharCode(code);
      s.index += 1 + number.length;
    } else {
      readable &&= !ANSI_C_UNREAD.test(rest);
      text += "\\";
      s.index += 1;
    }
  }

  s.index = Math.min(s.index + 1, s.text.length);

  return { text, readable };
}

// Whether the cursor is at `word` as a whole word.
export function atWord(s: Cursor, word: string): boolean {
  const after = s.index + word.length;

  return (
    s.text.startsWith(word, s.index) &&
    (after === s.text.length || WORD_END.test(at(s, word.length)))
  );
}

// Skips the blanks, newlines, and comments between the parts of a `case` statement.
export function skipCaseSeparators(s: Cursor): void {
  while (s.index < s.text.length) {
    const continuation = lineContinuation(s);

    if (continuation > 0) {
      s.index += continuation;
    } else if (isBlank(at(s)) || at(s) === "\n") {
      s.index += 1;
    } else if (at(s) === "#") {
      const newline = s.text.indexOf("\n", s.index);
      s.index = newline === -1 ? s.text.length : newline;
    } else {
      return;
    }
  }
}
