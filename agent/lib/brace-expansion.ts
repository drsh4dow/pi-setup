// Brace expansion of one shell word as bash 5.3 does it (braces.c: brace_expand,
// brace_gobbler, expand_amble, expand_seqterm, mkseq), in the C locale, so the shell
// command reader in shell-command.ts can judge each word bash produces. It works on the
// word as written, quotes included, as bash does before quote removal.

import { scanner, type Scanner, type Word } from "./shell-reading.ts";
import type { Script } from "./shell-script.ts";
import { assignsAt, mayExpandBraces } from "./word-forms.ts";

/** The most words one word may expand to; past it the reader leaves the word unread. */
export const MAX_BRACE_WORDS = 1024;

// The most digits a sequence term may have, so every term and step is exact in a double.
const MAX_DIGITS = 15;

/** The shell command reader's own functions, which brace expansion reads words with. */
export interface BraceReader {
  /** Reads one word at the scanner. */
  readonly readWord: (s: Scanner) => Word;
  /** Reads a `$( … )` or `$(( … ))` at the scanner, or returns undefined when none starts there. */
  readonly expansions: (s: Scanner) => readonly Script[] | undefined;
}

/** The index past the `$( … )` that starts at `index` in `text`, or undefined. */
export type SkipSubstitution = (text: string, index: number) => number | undefined;

type BraceType = "none" | "comma" | "sequence";

type TermType = "int" | "char" | "bad";

interface Gobbled {
  readonly found: boolean;
  readonly index: number;
  readonly type: BraceType;
}

const DIGIT = /^\d$/;

const LETTER = /^[A-Za-z]$/;

const LOWER = /^[a-z]$/;

const NUMBER = /^[+-]?\d+$/;

const LEADING_NUMBER = /^[+-]?\d+/;

const PADDED = /^-?0\d/;

const LINE_CONTINUATION = /\\\r?\n/;

// The characters after `${` that start a nofork command substitution, such as `${ cmd; }`.
const FUNSUB = /^[ \t\n|(]$/;

function braceWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t" || char === "\n";
}

function startsNumber(text: string): boolean {
  const [first = "", second = ""] = text;

  return DIGIT.test(first) || ((first === "+" || first === "-") && DIGIT.test(second));
}

// valid_seqterm's type of a term: a number, or a letter followed by `.` or the end
// when `endsTerm` allows it.
function termType(text: string, endsTerm: boolean): TermType {
  if (startsNumber(text)) return "int";

  const letterTerm =
    LETTER.test(text.charAt(0)) && ((endsTerm && text.length === 1) || text.charAt(1) === ".");

  return letterTerm ? "char" : "bad";
}

// valid_seqterm: the quick check that a brace body could be a sequence expression.
function validSequence(body: string): boolean {
  const dots = body.indexOf("..");

  if (dots === -1) return false;

  const rhs = body.slice(dots + 2);

  if (body.startsWith(".") || rhs === "") return false;

  const lhsType = termType(body, false);

  return lhsType !== "bad" && lhsType === termType(rhs, true);
}

function product(left: readonly string[], right: readonly string[]): string[] {
  return left.flatMap((head) => right.map((tail) => head + tail));
}

/**
 * Expands `raw`, one word as written, into the words bash makes of it, each still as
 * written. Undefined when bash's result depends on something not reproduced here: a
 * nofork or process substitution, a term of more than MAX_DIGITS digits, a range
 * through a non-letter, or more than MAX_BRACE_WORDS words.
 */
export function braceExpansion(
  raw: string,
  skipSubstitution: SkipSubstitution,
): readonly string[] | undefined {
  let exact = true;

  // Marks the expansion as one this module does not reproduce.
  const giveUp = (): [] => {
    exact = false;

    return [];
  };

  const capped = (words: string[]): string[] => (words.length > MAX_BRACE_WORDS ? giveUp() : words);

  // Scans `text` from `start` for `satisfy` outside quotes and nested braces.
  const gobble = (text: string, start: number, satisfy: "{" | "}" | ","): Gobbled => {
    const notFound: Gobbled = { found: false, index: text.length, type: "none" };
    let level = 0;
    let quoted = "";
    let passNext = false;
    let type: BraceType = "none";
    let commas = satisfy === "}" ? 0 : 1;
    let index = start;

    while (index < text.length) {
      const char = text.charAt(index);
      const next = text.charAt(index + 1);

      if (passNext) {
        passNext = false;
        index += 1;
        continue;
      }

      if (char === "\\" && quoted !== "'") {
        passNext = true;
        index += 1;
        continue;
      }

      // Bash reads `${` like `\{`, and its `}` closes a level.
      if (char === "$" && next === "{" && quoted !== "'") {
        if (FUNSUB.test(text.charAt(index + 2))) {
          giveUp();

          return notFound;
        }

        passNext = true;
        index += 1;

        if (quoted === "") level += 1;

        continue;
      }

      const substitution = char === "$" && next === "(" && (quoted === "" || quoted === '"');

      if (quoted !== "" && !substitution) {
        if (char === quoted) quoted = "";

        index += 1;
        continue;
      }

      if (substitution || ((char === "<" || char === ">") && next === "(")) {
        const end = char === "$" ? skipSubstitution(text, index) : undefined;

        if (end === undefined) {
          giveUp();

          return notFound;
        }

        index = end;
        continue;
      }

      if (char === '"' || char === "'" || char === "`") {
        quoted = char;
        index += 1;
        continue;
      }

      if (char === satisfy && level === 0 && commas > 0) {
        // An open brace alone, or before `}`, at the word's start or after a blank is literal.
        const literalOpen =
          char === "{" &&
          (index === 0 || braceWhitespace(text[index - 1])) &&
          (braceWhitespace(text[index + 1]) || next === "}");

        if (!literalOpen) break;

        index += 1;
        continue;
      }

      if (char === "{") level += 1;
      else if (char === "}" && level > 0) level -= 1;
      else if (satisfy === "}" && char === "," && level === 0) {
        type = "comma";
        commas += 1;
      } else if (
        satisfy === "}" &&
        text.startsWith("..", index) &&
        text.charAt(index + 2) !== "}" &&
        level === 0 &&
        type === "none"
      ) {
        type = "sequence";
        commas += 1;
      }

      index += 1;
    }

    return { found: index < text.length, index, type };
  };

  const expandAmble = (text: string): string[] => {
    const words: string[] = [];
    let start = 0;

    for (;;) {
      const separator = gobble(text, start, ",");

      words.push(...expand(text.slice(start, separator.index)));

      if (!separator.found || !exact) break;

      start = separator.index + 1;
    }

    return capped(words);
  };

  // The first `{` in `text` that begins a valid brace expansion, and its `}`.
  const firstBrace = (text: string): { open: number; close: Gobbled } | undefined => {
    for (let open = gobble(text, 0, "{").index; open < text.length;) {
      const close = gobble(text, open + 1, "}");

      if (!exact) return undefined;

      if (
        close.found &&
        (close.type !== "sequence" || validSequence(text.slice(open + 1, close.index)))
      )
        return { open, close };

      open = gobble(text, open + 1, "{").index;
    }

    return undefined;
  };

  const expand = (text: string): string[] => {
    const brace = firstBrace(text);

    if (brace === undefined) return exact ? [text] : [];

    const { open, close } = brace;
    const amble = text.slice(open + 1, close.index);
    const postamble = text.slice(close.index + 1);
    let alternatives: readonly string[];

    if (close.type === "sequence") {
      const terms = expandSequence(amble);

      if (terms === "inexact") return giveUp();

      if (terms !== undefined) alternatives = terms;
      else if (postamble !== "") alternatives = [`{${amble}}`];
      else return [text];
    } else {
      alternatives = expandAmble(amble);
    }

    const words = capped(product([text.slice(0, open)], alternatives));

    return postamble === "" ? words : capped(product(words, expand(postamble)));
  };

  const words = expand(raw);

  return exact ? words : undefined;
}

function exactNumber(text: string): number | undefined {
  return text.replace(/^[+-]/, "").length > MAX_DIGITS ? undefined : Number.parseInt(text, 10);
}

// expand_seqterm and mkseq: the words of a sequence expression such as `01..10..3`,
// undefined when bash leaves it as written, or "inexact" when this module cannot
// reproduce it.
function expandSequence(body: string): readonly string[] | "inexact" | undefined {
  const dots = body.indexOf("..");
  const lhs = body.slice(0, dots);
  const rhs = body.slice(dots + 2);

  if (lhs === "" || rhs === "") return undefined;

  let lhsType: TermType = "bad";

  if (NUMBER.test(lhs)) lhsType = "int";
  else if (LETTER.test(lhs)) lhsType = "char";

  const rhsType = termType(rhs, true);
  const rhsTerm = rhsType === "int" ? (LEADING_NUMBER.exec(rhs)?.[0] ?? "") : rhs.charAt(0);
  const rest = rhs.slice(rhsTerm.length);
  const step = rest.startsWith("..") ? rest.slice(2) : "";

  if (lhsType !== rhsType || lhsType === "bad") return undefined;

  if (rest !== "" && !NUMBER.test(step)) return undefined;

  const increment = step === "" ? 1 : exactNumber(step);

  if (increment === undefined) return "inexact";

  if (lhsType === "char") {
    // Bash steps through every byte between the letters; keep to ranges of letters only.
    if (LOWER.test(lhs) !== LOWER.test(rhsTerm)) return "inexact";

    return steps(lhs.charCodeAt(0), rhsTerm.charCodeAt(0), increment, (n) =>
      String.fromCharCode(n),
    );
  }

  const start = exactNumber(lhs);
  const end = exactNumber(rhsTerm);

  if (start === undefined || end === undefined) return "inexact";

  const width = PADDED.test(lhs) || PADDED.test(rhsTerm) ? Math.max(lhs.length, rhsTerm.length) : 0;

  return steps(start, end, increment, (n) => {
    const sign = n < 0 ? "-" : "";

    return sign + String(Math.abs(n)).padStart(width - sign.length, "0");
  });
}

function steps(
  start: number,
  end: number,
  step: number,
  format: (n: number) => string,
): readonly string[] | "inexact" {
  const magnitude = Math.abs(step === 0 ? 1 : step);
  const signed = start <= end ? magnitude : -magnitude;
  const count = Math.floor(Math.abs(end - start) / magnitude) + 1;

  if (count > MAX_BRACE_WORDS) return "inexact";

  return Array.from({ length: count }, (_, index) => format(start + index * signed));
}

/**
 * The words bash makes of `word`, the next word after `argv`, by brace expansion, each
 * read again; `word` itself when it expands no braces. A word whose expansion the reader
 * cannot reproduce stays one word, unread. Bash expands no braces in an assignment
 * before the command word, and drops a word that expands to nothing. `s` is the scanner
 * the word was read with.
 */
export function braceWords(
  argv: readonly string[],
  word: Word,
  s: Scanner,
  reader: BraceReader,
): readonly Word[] {
  if (!word.unquoted.includes("{") || assignsAt(argv, word)) return [word];

  const unread: readonly Word[] = [
    { ...word, unread: word.unread ?? (mayExpandBraces(word.unquoted) ? "brace" : undefined) },
  ];

  // Bash joins a line continuation before it expands braces. Expanding reads a word's
  // substitutions again, once per word it makes; inside another script that would
  // repeat at every level. Both stay unread.
  if (LINE_CONTINUATION.test(word.raw) || (word.nested.length > 0 && s.reading.depth > 1))
    return unread;

  const expanded = braceExpansion(word.raw, (text, index) => {
    const inner = { ...scanner(text, s), index };

    return reader.expansions(inner) === undefined ? undefined : inner.index;
  });

  if (expanded === undefined) return unread;

  if (expanded.length === 1 && expanded[0] === word.raw) return [word];

  const words: Word[] = [];

  for (const raw of expanded.filter((text) => text !== "")) {
    const piece = scanner(raw, s);
    const read = reader.readWord(piece);

    if (piece.index !== raw.length) return unread;

    words.push(read);
  }

  return words;
}
