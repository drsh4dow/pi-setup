// Character-level reads over shell text, for the shell command reader in
// shell-command.ts: quoting, line continuations, blanks, comments, and the
// separators between the parts of a `case` statement.

/** Shell text and the reader's position in it. */
export interface Cursor {
  readonly text: string;
  index: number;
}

export const WORD_END = /[ \t\r\n;&|()<>]/;

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

// `$'…'` ANSI-C quoting: a backslash escapes the next character, so `\'` does not close it.
export function ansiQuoted(s: Cursor): string {
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
