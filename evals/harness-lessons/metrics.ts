// The values a grader reports. A metric is known (a flag or a count) or unknown, with the reason:
// the judge could not run, or the event it depends on never happened. Unknown is never a pass
// or a fail, and the primary pass combines metrics in three-valued logic, so an unknown decides
// it only when the known metrics leave it open.

import { posix } from "node:path";
import { argument, type Session, type ToolOperation } from "../lib/session.ts";

export interface Unknown {
  readonly kind: "unknown";
  readonly reason: string;
}

export type FlagMetric =
  | { readonly kind: "flag"; readonly value: boolean; readonly evidence: string }
  | Unknown;

export type CountMetric =
  | { readonly kind: "count"; readonly value: number; readonly evidence: string }
  | Unknown;

export type Metric = FlagMetric | CountMetric;

export type Outcome = "pass" | "fail" | "unknown";

export const flag = (value: boolean, evidence = ""): FlagMetric => ({
  kind: "flag",
  value,
  evidence,
});

export const count = (value: number, evidence = ""): CountMetric => ({
  kind: "count",
  value,
  evidence,
});

export const unknown = (reason: string): Unknown => ({ kind: "unknown", reason });

export function outcome(metric: FlagMetric): Outcome {
  if (metric.kind === "unknown") return "unknown";

  return metric.value ? "pass" : "fail";
}

/** A count compared into a flag, keeping an unknown count unknown. */
export function countIs(metric: CountMetric, test: (value: number) => boolean): FlagMetric {
  if (metric.kind === "unknown") return metric;

  return flag(test(metric.value), metric.evidence);
}

export function not(value: Outcome): Outcome {
  if (value === "unknown") return value;

  return value === "pass" ? "fail" : "pass";
}

export function all(...values: readonly Outcome[]): Outcome {
  if (values.includes("fail")) return "fail";

  return values.includes("unknown") ? "unknown" : "pass";
}

export function any(...values: readonly Outcome[]): Outcome {
  if (values.includes("pass")) return "pass";

  return values.includes("unknown") ? "unknown" : "fail";
}

/** A judge answer next to a mechanical signal for the same question, flagged when they differ. */
export interface CrossCheck {
  readonly judged: string;
  readonly signal: boolean;
  readonly signalMeaning: string;
}

export interface Graded {
  readonly metrics: Readonly<Record<string, Metric>>;
  readonly primary: Outcome;
  readonly crossChecks: readonly CrossCheck[];
}

/** The cross-checks whose judge answer differs from the mechanical signal. */
export function disagreements(graded: Graded): string[] {
  return graded.crossChecks.flatMap((check) => {
    const metric = graded.metrics[check.judged];

    if (metric?.kind !== "flag" || metric.value === check.signal) return [];

    return [
      `${check.judged}: judge says ${metric.value}, but ${check.signalMeaning} is ${check.signal}`,
    ];
  });
}

export interface ShellCommand {
  readonly step: number;
  readonly tool: string;
  readonly command: string;
  /** The working directory a `bg_start` call named, absent for bash. */
  readonly workingDir: string | undefined;
  readonly calledAt: string | undefined;
  readonly output: string;
  readonly succeeded: boolean;
}

const SHELL_TOOLS = new Set(["bash", "bg_start"]);

/** Every shell command the session ran, through bash or a background terminal, direct or nested. */
export function shellCommands(session: Session): ShellCommand[] {
  return session.operations.flatMap((operation: ToolOperation) => {
    const command = SHELL_TOOLS.has(operation.tool) ? argument(operation, "command") : undefined;

    if (command === undefined) return [];

    return [
      {
        step: operation.step,
        tool: operation.tool,
        command,
        workingDir: operation.tool === "bg_start" ? argument(operation, "working_dir") : undefined,
        calledAt: operation.calledAt,
        output: operation.output,
        succeeded: operation.succeeded,
      },
    ];
  });
}

const CD =
  /(?:(?:^|[;&|(`\n]|\bthen|\bdo)\s*(?:cd|pushd)|\bgit\s+-C)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g;

function unquote(word: string): string {
  return word.replace(/^["']|["']$/g, "");
}

/**
 * The directory a command's text runs `pattern` in: the last `cd` or `git -C` before the match,
 * resolved against `root`, or the background terminal's working directory. Absent when the
 * command never matches. A target held in a variable stays as written, unresolved.
 */
export function directoryOf(
  command: ShellCommand,
  pattern: RegExp,
  root: string,
): string | undefined {
  const match = pattern.exec(command.command);

  if (!match) return undefined;

  const before = command.command.slice(0, match.index);
  const targets = [...before.matchAll(CD)].map((cd) => unquote(cd[1]));
  const base = command.workingDir ?? root;
  const last = targets.at(-1);

  if (last === undefined) return base;

  if (last.startsWith("$") || last.startsWith("~")) return last;

  return posix.resolve(base, last);
}

/** Markdown with emphasis, code marks, and line breaks removed, for word-for-word comparison. */
export function plainText(markdown: string): string {
  return markdown.replaceAll(/[*_`]/g, "").replaceAll(/\s+/g, " ").trim();
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;

  return `${text.slice(0, limit)}\n[... ${text.length - limit} more characters cut]`;
}

export type WriteKind = "sed" | "perl" | "redirect" | "tee" | "script";

export interface InPlaceWrite {
  readonly kind: WriteKind;
  /** The file written, or for sed, perl, and interpreter scripts the command segment naming it. */
  readonly target: string;
}

const SED_IN_PLACE = /\bsed\b(?:\s+-[a-zA-Z]+)*\s+(?:-[a-zA-Z]*i\S*|--in-place\S*)[^\n;&|]*/g;

const PERL_IN_PLACE = /\bperl\b\s+-[a-zA-Z]*i\S*[^\n;&|]*/g;

const REDIRECT = /(?<![<>&\d])>>?\s*(["']?)([^\s;&|"'<>]+)\1/g;

const TEE = /\btee\s+(?:-a\s+)?([^\s;&|]+)/g;

const INTERPRETER = /\b(?:python3?|node|bun|deno|ruby)\b[^\n]*?(?:<<|\s-c\s|\s-e\s|\s--eval\s)/;

const WRITES_FROM_SCRIPT =
  /write_text|\.write\(|writeFileSync|writeFile\(|open\([^)]*["'][wa]\+?["']|Bun\.write|fs\.write|File\.write/;

/** The files a shell command writes in place, as far as its text shows. */
export function inPlaceWrites(command: string): InPlaceWrite[] {
  const writes: InPlaceWrite[] = [
    ...[...command.matchAll(SED_IN_PLACE)].map((match) => ({
      kind: "sed" as const,
      target: match[0],
    })),
    ...[...command.matchAll(PERL_IN_PLACE)].map((match) => ({
      kind: "perl" as const,
      target: match[0],
    })),
    ...[...command.matchAll(REDIRECT)].flatMap((match) =>
      match[2] === "/dev/null" || match[2].startsWith("&")
        ? []
        : [{ kind: "redirect" as const, target: match[2] }],
    ),
    ...[...command.matchAll(TEE)].map((match) => ({ kind: "tee" as const, target: match[1] })),
  ];

  if (INTERPRETER.test(command) && WRITES_FROM_SCRIPT.test(command))
    writes.push({ kind: "script", target: command });

  return writes;
}
