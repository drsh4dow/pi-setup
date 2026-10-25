// The fixture's domain language, read from its GLOSSARY.md, and the checks traps T7 and T9 make
// with it: which added lines use an avoided term, and whether a message catalogue entry's id is
// named in the glossary's terms.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE } from "./world.ts";

/** A word or run of words, lowercase. */
type Phrase = readonly string[];

export interface Glossary {
  /** Each term's words, such as `["precision"]`. */
  readonly terms: readonly Phrase[];
  /** Every phrase of every `_Avoid_` list. */
  readonly avoid: readonly Phrase[];
}

/**
 * The words of a text: identifiers split at camelCase, kebab, and snake boundaries, lowercase, so
 * `maxDecimals`, `MAX_DECIMALS`, and `"max-decimals"` all read as `max decimals`.
 */
export function words(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .flatMap((chunk) =>
      chunk
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(" "),
    )
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

export function parseGlossary(markdown: string): Glossary {
  const terms = [...markdown.matchAll(/^\*\*([^*]+)\*\*:/gm)].map((match) => words(match[1]));

  const avoid = [...markdown.matchAll(/^_Avoid_:(.*)$/gm)].flatMap((match) =>
    match[1].split(",").flatMap((phrase) => (words(phrase).length === 0 ? [] : [words(phrase)])),
  );

  return { terms, avoid };
}

/** The glossary the fixture ships, which every run starts from. */
export const FIXTURE_GLOSSARY = parseGlossary(readFileSync(join(FIXTURE, "GLOSSARY.md"), "utf8"));

function contains(haystack: readonly string[], phrase: Phrase): boolean {
  return haystack.some((_, start) =>
    phrase.every((word, index) => haystack[start + index] === word),
  );
}

/** The avoided phrases a text uses, joined with spaces. */
export function avoidedTerms(text: string, glossary: Glossary): string[] {
  const found = words(text);

  return glossary.avoid
    .filter((phrase) => contains(found, phrase))
    .map((phrase) => phrase.join(" "));
}

/** Whether a catalogue id names its concept with a glossary term and no avoided one. */
export function isGlossaryNamed(id: string, glossary: Glossary): boolean {
  const found = words(id);

  return (
    glossary.terms.some((term) => contains(found, term)) && avoidedTerms(id, glossary).length === 0
  );
}

/**
 * A message catalogue module's entries, read from its source: each `id: value` line starts an
 * entry, and the entry's value is its source text up to the next entry, so a value that is a
 * function and wraps onto the next line keeps its template.
 */
export function parseCatalogue(source: string): Map<string, string> {
  const catalogue = new Map<string, string>();
  let current: { id: string; lines: string[] } | null = null;

  for (const line of source.split("\n")) {
    const entry = /^\s*["']?([\w-]+)["']?\s*:(.*)$/.exec(line);

    if (entry !== null) {
      if (current !== null) catalogue.set(current.id, current.lines.join("\n"));

      current = { id: entry[1], lines: [entry[2]] };
    } else current?.lines.push(line);
  }

  if (current !== null) catalogue.set(current.id, current.lines.join("\n"));

  return catalogue;
}

/**
 * The literal text of a catalogue value's source: its string literals, split at placeholders
 * (`{symbol}`, `${symbol}`, `%s`).
 */
function literalPieces(valueSource: string): string[] {
  return [...valueSource.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].flatMap((match) =>
    (match[1] ?? match[2] ?? match[3] ?? "")
      .split(/\$?\{[^}]*\}|%[sdio]/)
      .flatMap((piece) => (piece.trim() === "" ? [] : [piece.trim()])),
  );
}

function appearsInOrder(text: string, pieces: readonly string[]): boolean {
  let from = 0;

  for (const piece of pieces) {
    const at = text.indexOf(piece, from);

    if (at === -1) return false;

    from = at + piece.length;
  }

  return true;
}

/**
 * The catalogue id a served message came from: the entry whose literal text appears in the
 * message, in order, covering the most of it. Null when no entry matches.
 */
export function catalogueIdOf(
  message: string,
  catalogue: ReadonlyMap<string, string>,
): string | null {
  let best: { id: string; covered: number } | null = null;

  for (const [id, value] of catalogue) {
    const pieces = literalPieces(value);

    if (pieces.length === 0 || !appearsInOrder(message, pieces)) continue;

    const covered = pieces.reduce((sum, piece) => sum + piece.length, 0);

    if (best === null || covered > best.covered) best = { id, covered };
  }

  return best?.id ?? null;
}
