// Where a run's wall time goes: the spans of the root's lifetime with no child session running,
// which put the root on the critical path, and the root's model time inside them. Ported from the
// 2026-10-25 research script `crit.mjs`, which sampled the wall time once a second; this measures
// the intervals exactly.

import { readFileSync } from "node:fs";
import { Option, Schema } from "effect";

/** A closed interval of epoch milliseconds. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

export interface SessionClock {
  /** The first to the last timestamped line of the session. */
  readonly span: Span;
  /** Each assistant message, from the session's previous timestamped line to the message. */
  readonly assistantLatencies: readonly Span[];
}

const TimestampedLine = Schema.Struct({
  timestamp: Schema.String,
  message: Schema.optionalKey(Schema.Struct({ role: Schema.optionalKey(Schema.String) })),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(TimestampedLine));

/** The clock of a session file, or null when no line carries a timestamp. */
export function readSessionClock(file: string): SessionClock | null {
  let first: number | null = null;
  let previous: number | null = null;
  const assistantLatencies: Span[] = [];

  for (const text of readFileSync(file, "utf8").split("\n")) {
    const line = decodeLine(text);

    if (Option.isNone(line)) continue;

    const at = Date.parse(line.value.timestamp);

    if (Number.isNaN(at)) continue;

    if (previous !== null && line.value.message?.role === "assistant")
      assistantLatencies.push({ start: previous, end: at });

    first ??= at;
    previous = at;
  }

  if (first === null || previous === null) return null;

  return { span: { start: first, end: previous }, assistantLatencies };
}

/** The spans sorted and merged, so no two overlap. */
function union(spans: readonly Span[]): Span[] {
  const merged: Span[] = [];

  for (const span of spans.toSorted((left, right) => left.start - right.start)) {
    const last = merged.at(-1);

    if (last !== undefined && span.start <= last.end)
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    else merged.push(span);
  }

  return merged;
}

export interface RootIdle {
  /** Wall milliseconds of the root's lifetime with no child session running. */
  readonly idleMs: number;
  /** Root model milliseconds whose interval's midpoint has no child session running. */
  readonly modelIdleMs: number;
}

export function rootIdle({
  root,
  children,
}: {
  root: SessionClock;
  children: readonly Span[];
}): RootIdle {
  const busy = union(children);
  const running = (at: number) => busy.some((span) => span.start <= at && at <= span.end);

  const covered = busy.reduce(
    (sum, span) =>
      sum + Math.max(0, Math.min(span.end, root.span.end) - Math.max(span.start, root.span.start)),
    0,
  );

  const modelIdleMs = root.assistantLatencies
    .filter((latency) => !running((latency.start + latency.end) / 2))
    .reduce((sum, latency) => sum + latency.end - latency.start, 0);

  return { idleMs: root.span.end - root.span.start - covered, modelIdleMs };
}

/** How long two sets of spans ran at the same time. */
export function overlapMs(left: readonly Span[], right: readonly Span[]): number {
  const rightUnion = union(right);

  return union(left).reduce(
    (sum, span) =>
      sum +
      rightUnion.reduce(
        (inner, other) =>
          inner + Math.max(0, Math.min(span.end, other.end) - Math.max(span.start, other.start)),
        0,
      ),
    0,
  );
}
