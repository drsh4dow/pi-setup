// Reads what a literal `printf` prints, for command-input.ts. It reproduces exactly the
// `%s`, `%b`, and `%%` conversions and the escapes on which bash's builtin printf and
// coreutils' printf agree. Any other feature makes the reading inexact, so the host
// guard refuses to run it as a script instead of trusting an approximation.

/** The text a literal `echo` or `printf` prints. */
export interface Printed {
  readonly text: string;
  /** False when the command uses a feature the reader does not reproduce, so `text` only approximates it. */
  readonly readable: boolean;
}

// Where an escape is read: in the format, or in an argument of `%b`, which reads
// octal escapes and `\c` differently.
type EscapeContext = "format" | "argument";

interface Escape {
  readonly text: string;
  readonly length: number;
  readonly readable: boolean;
  /** `\c` in a `%b` argument: printf prints nothing more. */
  readonly ends: boolean;
}

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["a", "\u0007"],
  ["b", "\b"],
  ["e", "\u001B"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ["v", "\v"],
  ["\\", "\\"],
]);

// Escapes that bash's builtin and coreutils print differently, such as `\?`, `\E`, and
// `\%`, or that the reader does not reproduce, such as `\u` and `\U`.
const UNREAD_ESCAPES: ReadonlySet<string> = new Set(["?", "E", "U", "u", "%"]);

const HEX_DIGITS = /^[0-9A-Fa-f]{1,2}/;

// `\NNN` in the format; `\0NNN` or `\NNN` in a `%b` argument.
const OCTAL_DIGITS: Readonly<Record<EscapeContext, RegExp>> = {
  format: /^[0-7]{1,3}/,
  argument: /^(?:0[0-7]{0,3}|[1-7][0-7]{0,2})/,
};

// A conversion the reader does not reproduce: flags, a width or precision, `*`, a
// length modifier, and any letter, or a lone `%` at the end of the format.
const OTHER_CONVERSION = /^%[-+ #0']*(\*|\d*)(?:\.(\*|\d*))?[hlLqjzt]*([A-Za-z]?)/;

function literal(text: string, readable: boolean): Escape {
  return { text, length: text.length, readable, ends: false };
}

// An octal or hex escape: the byte it prints and the length of its text after the backslash.
function byteEscape(
  rest: string,
  context: EscapeContext,
): { code: number; length: number } | undefined {
  const octal = OCTAL_DIGITS[context].exec(rest)?.[0];

  if (octal !== undefined) return { code: Number.parseInt(octal, 8) % 256, length: octal.length };

  const hex = rest.startsWith("x") ? HEX_DIGITS.exec(rest.slice(1))?.[0] : undefined;

  return hex === undefined ? undefined : { code: Number.parseInt(hex, 16), length: 1 + hex.length };
}

// The escape at `index`, where `text` has a backslash.
function readEscape(text: string, index: number, context: EscapeContext): Escape {
  const char = text.charAt(index + 1);
  const rest = text.slice(index + 1);
  const simple = SIMPLE_ESCAPES.get(char);

  if (char === "") return literal("\\", true);

  if (simple !== undefined) return { text: simple, length: 2, readable: true, ends: false };

  const byte = byteEscape(rest, context);

  // A NUL byte in a script is a case the reader does not follow.
  if (byte !== undefined) {
    const { code, length } = byte;

    return {
      text: String.fromCodePoint(code),
      length: 1 + length,
      readable: code !== 0,
      ends: false,
    };
  }

  if (char === "c" && context === "argument")
    return { text: "", length: 2, readable: true, ends: true };

  // bash prints `\"` in the format as `"`, as coreutils does; for `\'` in the format and
  // both in `%b`, one of them keeps the backslash.
  if (char === '"' && context === "format")
    return { text: char, length: 2, readable: true, ends: false };

  if (char === '"' || char === "'") return literal(`\\${char}`, false);

  // `\x` with no hex digit, `\c` in the format, and the escapes above, on which they disagree.
  const unread = char === "x" || char === "c" || UNREAD_ESCAPES.has(char);

  return literal(`\\${char}`, !unread);
}

interface Conversion {
  readonly text: string;
  readonly length: number;
  readonly readable: boolean;
  readonly ends: boolean;
  readonly used: number;
}

// The conversion at `index`, where `format` has a `%`, given the next unused argument.
function readConversion(format: string, index: number, args: readonly string[]): Conversion {
  const letter = format.charAt(index + 1);

  if (letter === "%") return { text: "%", length: 2, readable: true, ends: false, used: 0 };

  if (letter === "s")
    return { text: args[0] ?? "", length: 2, readable: true, ends: false, used: 1 };

  if (letter === "b") {
    const printed = argumentText(args[0] ?? "");

    return { ...printed, length: 2, used: 1 };
  }

  // Approximate it as the argument it prints, after any `*` widths it takes.
  const [conversion = "%", width, precision, other = ""] =
    OTHER_CONVERSION.exec(format.slice(index)) ?? [];

  const stars = Number(width === "*") + Number(precision === "*");
  const used = stars + Number(other !== "");

  return {
    text: other === "" ? "" : (args[stars] ?? ""),
    length: conversion.length,
    readable: false,
    ends: false,
    used,
  };
}

// What `%b` prints for one argument: its escapes read, up to a `\c`.
function argumentText(arg: string): Omit<Escape, "length"> {
  let text = "";
  let readable = true;

  for (let index = 0; index < arg.length;) {
    if (arg.charAt(index) !== "\\") {
      text += arg.charAt(index);
      index += 1;
      continue;
    }

    const escape = readEscape(arg, index, "argument");
    text += escape.text;
    readable &&= escape.readable;
    index += escape.length;

    if (escape.ends) return { text, readable, ends: true };
  }

  return { text, readable, ends: false };
}

/** What `printf format args…` prints: the format is applied again while arguments remain. */
export function printfOutput(format: string, args: readonly string[]): Printed {
  let text = "";
  let readable = true;
  let next = 0;

  do {
    const start = next;

    for (let index = 0; index < format.length;) {
      const char = format.charAt(index);

      if (char !== "\\" && char !== "%") {
        text += char;
        index += 1;
        continue;
      }

      const read =
        char === "\\"
          ? { ...readEscape(format, index, "format"), used: 0 }
          : readConversion(format, index, args.slice(next));

      text += read.text;
      readable &&= read.readable;
      index += read.length;
      next += read.used;

      if (read.ends) return { text, readable };
    }

    // A format with no conversion prints once, whatever the arguments.
    if (next === start) break;
  } while (next < args.length);

  return { text, readable };
}
