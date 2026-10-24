// Grades an implement-chunk eval directory: per run, the metrics and the harness-isolation check;
// per arm, n, the correct rate, medians with min–max, and the per-trap tallies; then the
// pre-registered reading for each non-baseline arm against `baseline`.
//
// Usage: node evals/implement-chunk/grade.ts <out> [--json]

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Option, Schema } from "effect";
import { writeAtomically } from "../lib/pi-run.ts";
import {
  checkSession,
  differingAppendices,
  sessionFiles,
  type SessionHarness,
} from "./isolation.ts";
import { IntegrityRecord, runIntegrity, type Integrity } from "./integrity.ts";
import { runMetrics, type Measured, type RunMetrics } from "./metrics.ts";
import { readSessionFacts } from "./sessions.ts";

const RunRecord = Schema.Struct({
  arm: Schema.Struct({ name: Schema.String, root: Schema.String, head: Schema.String }),
  trial: Schema.Int,
  agentDir: Schema.optionalKey(Schema.String),
  integrity: Schema.optionalKey(IntegrityRecord),
});

const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(RunRecord));

export interface Isolation {
  readonly ok: boolean;
  readonly sessions: number;
  readonly bad: readonly SessionHarness[];
}

/** The run's scratch directory: the root of its home, or the parent of the root's checkout. */
function runScratch(runDir: string, agentDir: string | undefined): string {
  return agentDir === undefined
    ? dirname(readSessionFacts(join(runDir, "root.jsonl")).cwd)
    : dirname(dirname(dirname(agentDir)));
}

/** Whether the root and every child session of a run loaded the arm's harness, not the live one. */
export function runIsolation(runDir: string, agentDir: string | undefined): Isolation {
  const rootFile = join(runDir, "root.jsonl");
  const harness = join(runDir, "harness");

  if (!existsSync(rootFile) || !existsSync(harness))
    return {
      ok: false,
      sessions: 0,
      bad: [
        {
          file: runDir,
          name: null,
          ok: false,
          problems: ["no root session or harness snapshot to check"],
        },
      ],
    };

  const runAgentDir = agentDir ?? join(runScratch(runDir, undefined), "home", ".pi", "agent");

  const liveSnapshot = join(harness, "live-subagents");

  const files = [
    rootFile,
    ...(existsSync(join(runDir, "sessions")) ? sessionFiles(join(runDir, "sessions")) : []),
  ];

  const expected = {
    systemPrompt: readFileSync(join(harness, "SYSTEM.md"), "utf8"),
    runAgentDir,
    liveAgentDir: join(homedir(), ".pi", "agent"),
    differingAppendices: differingAppendices({
      liveSubagents: existsSync(liveSnapshot)
        ? liveSnapshot
        : join(homedir(), ".pi", "agent", "skills", "subagents"),
      armSubagents: join(harness, "subagents"),
    }),
    marker: null,
  };

  const results = files.map((file) => checkSession(file, expected));
  const bad = results.filter((result) => !result.ok);

  return { ok: bad.length === 0, sessions: results.length, bad };
}

export interface GradedRun {
  readonly arm: string;
  readonly trial: number;
  readonly isolation: Isolation;
  /** Whether the run left the arm and the live harness as it found them. */
  readonly integrity: Integrity;
  readonly metrics: RunMetrics;
}

/** A run counts toward its arm only when it ran the arm's harness and changed neither source. */
export const isValid = (run: GradedRun) => run.isolation.ok && run.integrity.ok;

type NumericKey = {
  [K in keyof RunMetrics]: RunMetrics[K] extends Measured<number> ? K : never;
}[keyof RunMetrics];

export const NUMERIC: readonly NumericKey[] = [
  "t1RefusedMerges",
  "t1RecoverySpawns",
  "t2CommentLines",
  "t2FixSpawns",
  "t3ChangelogCiFailures",
  "t3ScopeStops",
  "t3Respawns",
  "t4AutoDone",
  "t4Resets",
  "t4WrongAtMergeReady",
  "t4WrongAtClose",
  "t6ReviewToMergeReadyMinutes",
  "spawns",
  "rootLaunches",
  "fixRounds",
  "respawns",
  "resumes",
  "humanTurns",
  "reAsks",
  "statusRequests",
  "wallMinutes",
  "rootCost",
  "childCost",
  "ruleBreaks",
  "finalPRs",
];

export interface Spread {
  readonly n: number;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly unknown: number;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function spread(values: readonly Measured<number>[]): Spread | null {
  const knownValues = values
    .flatMap((value) => (value.known ? [value.value] : []))
    .toSorted((left, right) => left - right);

  if (knownValues.length === 0) return null;

  return {
    n: knownValues.length,
    median: median(knownValues),
    min: knownValues[0],
    max: knownValues.at(-1) ?? knownValues[0],
    unknown: values.length - knownValues.length,
  };
}

export interface ArmSummary {
  readonly arm: string;
  readonly n: number;
  /** Runs dropped because a session loaded the wrong harness or the run changed a source. */
  readonly invalid: number;
  readonly correct: { readonly yes: number; readonly known: number };
  readonly t5: Readonly<Record<string, number>>;
  readonly metrics: Readonly<Partial<Record<NumericKey, Spread>>>;
}

export function summarize(arm: string, runs: readonly GradedRun[]): ArmSummary {
  const valid = runs.filter(isValid);
  const metrics: Partial<Record<NumericKey, Spread>> = {};

  for (const key of NUMERIC) {
    const result = spread(valid.map((run) => run.metrics[key]));

    if (result !== null) metrics[key] = result;
  }

  const t5: Record<string, number> = {};

  for (const run of valid) {
    const label = run.metrics.t5.known ? run.metrics.t5.value : "unknown";

    t5[label] = (t5[label] ?? 0) + 1;
  }

  const correct = valid.flatMap((run) =>
    run.metrics.correct.known ? [run.metrics.correct.value] : [],
  );

  return {
    arm,
    n: valid.length,
    invalid: runs.length - valid.length,
    correct: { yes: correct.filter(Boolean).length, known: correct.length },
    t5,
    metrics,
  };
}

export type Verdict = "better" | "worse" | "same" | "within spread" | "unknown";

export interface Comparison {
  readonly name: string;
  readonly verdict: Verdict;
  readonly detail: string;
}

/** Lower is better. Two arms differ only when their min–max ranges do not overlap. */
function compareLower(
  name: string,
  baseline: Spread | undefined,
  candidate: Spread | undefined,
): Comparison {
  if (baseline === undefined || candidate === undefined)
    return { name, verdict: "unknown", detail: "no known value in one arm" };

  const detail = `baseline ${baseline.median} [${baseline.min}–${baseline.max}], candidate ${candidate.median} [${candidate.min}–${candidate.max}]`;

  if (candidate.median === baseline.median) return { name, verdict: "same", detail };

  if (candidate.max < baseline.min) return { name, verdict: "better", detail };

  if (candidate.min > baseline.max) return { name, verdict: "worse", detail };

  return { name, verdict: "within spread", detail: `${detail}; ranges overlap` };
}

function costOf(summary: ArmSummary): number | null {
  const root = summary.metrics.rootCost;
  const child = summary.metrics.childCost;

  return root === undefined || child === undefined ? null : root.median + child.median;
}

export interface Reading {
  readonly candidate: string;
  readonly comparisons: readonly Comparison[];
  readonly correctNotLower: boolean | null;
  readonly costRatio: number | null;
  readonly better: boolean | null;
  readonly sentence: string;
}

/**
 * The pre-registered reading: better if correctness is not lower, at least three of {T1, T3, T4
 * resets, T5 caught, respawns, humanTurns} improve, and total cost rises by no more than 15%.
 */
export function reading(baseline: ArmSummary, candidate: ArmSummary): Reading {
  const t5Caught = (summary: ArmSummary) =>
    summary.n === 0 ? null : (summary.t5["caught-before-merge"] ?? 0) / summary.n;

  const caughtBase = t5Caught(baseline);
  const caughtCandidate = t5Caught(candidate);
  let t5: Comparison = { name: "T5 caught", verdict: "unknown", detail: "no runs" };

  if (caughtBase !== null && caughtCandidate !== null) {
    const detail = `caught before merge: baseline ${caughtBase.toFixed(2)}, candidate ${caughtCandidate.toFixed(2)}`;
    let verdict: Verdict = "same";

    if (caughtCandidate > caughtBase) verdict = "better";
    else if (caughtCandidate < caughtBase) verdict = "worse";

    t5 = { name: "T5 caught", verdict, detail };
  }

  const comparisons = [
    compareLower(
      "T1 refused merges",
      baseline.metrics.t1RefusedMerges,
      candidate.metrics.t1RefusedMerges,
    ),
    compareLower(
      "T3 scope-stop respawns",
      baseline.metrics.t3Respawns,
      candidate.metrics.t3Respawns,
    ),
    compareLower("T4 resets", baseline.metrics.t4Resets, candidate.metrics.t4Resets),
    t5,
    compareLower("respawns", baseline.metrics.respawns, candidate.metrics.respawns),
    compareLower("humanTurns", baseline.metrics.humanTurns, candidate.metrics.humanTurns),
  ];

  const rate = (summary: ArmSummary) =>
    summary.correct.known === 0 ? null : summary.correct.yes / summary.correct.known;

  const baseRate = rate(baseline);
  const candidateRate = rate(candidate);

  const correctNotLower =
    baseRate === null || candidateRate === null ? null : candidateRate >= baseRate;

  const baseCost = costOf(baseline);
  const candidateCost = costOf(candidate);

  const costRatio =
    baseCost === null || candidateCost === null || baseCost === 0 ? null : candidateCost / baseCost;

  const improved = comparisons.filter((comparison) => comparison.verdict === "better").length;

  const better =
    correctNotLower === null || costRatio === null
      ? null
      : correctNotLower && improved >= 3 && costRatio <= 1.15;

  let verdictWord = "cannot be read (a needed value is unknown)";

  if (better !== null) verdictWord = better ? "is better" : "is not better";

  return {
    candidate: candidate.arm,
    comparisons,
    correctNotLower,
    costRatio,
    better,
    sentence: `${candidate.arm} ${verdictWord}: correctness not lower ${String(correctNotLower)}, ${improved} of 6 improved beyond spread, cost ratio ${costRatio === null ? "unknown" : costRatio.toFixed(2)}`,
  };
}

function format<T>(value: Measured<T>, show: (known: T) => string = String): string {
  return value.known ? show(value.value) : `unknown (${value.reason})`;
}

const round = (value: number) => String(Math.round(value * 100) / 100);

function runLines(run: GradedRun): string[] {
  const { metrics } = run;

  const lines = [
    `-- ${run.arm} t${run.trial}: stop "${metrics.stop}", isolation ${run.isolation.ok ? "ok" : "WRONG HARNESS"} (${run.isolation.sessions} sessions), integrity ${run.integrity.ok ? "ok" : "INVALID"}`,
  ];

  for (const bad of run.isolation.bad)
    lines.push(`   ! ${bad.name ?? bad.file}: ${bad.problems.join("; ")}`);

  for (const problem of run.integrity.problems) lines.push(`   ! integrity: ${problem}`);

  lines.push(`   correct: ${format(metrics.correct)}`);

  if (metrics.acceptanceFailures.length > 0)
    lines.push(`   acceptanceFailures: ${metrics.acceptanceFailures.join(" | ")}`);

  lines.push(
    `   t5: ${format(metrics.t5)}`,
    `   t6WatcherErrors: ${format(metrics.t6WatcherErrors)}`,
  );

  for (const key of NUMERIC) lines.push(`   ${key}: ${format(metrics[key], round)}`);

  lines.push(
    `   spawnsByRole: ${JSON.stringify(metrics.spawnsByRole)}`,
    `   ledgerAtHead: ${format(metrics.ledgerAtHead)}`,
    `   finalPRsSelfContained: ${format(metrics.finalPRsSelfContained)}`,
  );

  if (metrics.ruleBreakSamples.length > 0)
    lines.push(`   ruleBreakSamples: ${metrics.ruleBreakSamples.join(" | ")}`);

  return lines;
}

function summaryLines(summary: ArmSummary): string[] {
  const rate =
    summary.correct.known === 0 ? "unknown" : `${summary.correct.yes}/${summary.correct.known}`;

  const lines = [
    `== ${summary.arm}: n=${summary.n} (invalid ${summary.invalid}), correct ${rate}, T5 ${JSON.stringify(summary.t5)}`,
  ];

  for (const [key, value] of Object.entries(summary.metrics)) {
    lines.push(
      `   ${key.padEnd(28)} ${String(Math.round(value.median * 100) / 100).padStart(7)}  [${Math.round(value.min * 100) / 100}–${Math.round(value.max * 100) / 100}]${value.unknown > 0 ? `  (${value.unknown} unknown)` : ""}`,
    );
  }

  return lines;
}

export async function gradeDirectory(
  out: string,
): Promise<{ runs: GradedRun[]; summaries: ArmSummary[]; readings: Reading[] }> {
  const arms = readdirSync(out, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? [entry.name] : []))
    .toSorted();

  const finished = arms.flatMap((arm) =>
    readdirSync(join(out, arm)).flatMap((trial) => {
      const dir = join(out, arm, trial);

      const record =
        /^t\d+$/.test(trial) && existsSync(join(dir, "run.json"))
          ? decodeRun(readFileSync(join(dir, "run.json"), "utf8"))
          : Option.none();

      return Option.isSome(record) ? [{ arm, dir, record: record.value }] : [];
    }),
  );

  const runs = await Promise.all(
    finished.map(async ({ arm, dir, record }): Promise<GradedRun> => ({
      arm,
      trial: record.trial,
      isolation: runIsolation(dir, record.agentDir),
      integrity: existsSync(join(dir, "root.jsonl"))
        ? runIntegrity({
            runDir: dir,
            record: record.integrity ?? null,
            scratch: runScratch(dir, record.agentDir),
          })
        : { ok: false, problems: ["no root session to check"] },
      metrics: await runMetrics(dir),
    })),
  );

  const summaries = [...new Set(runs.map((run) => run.arm))].map((arm) =>
    summarize(
      arm,
      runs.filter((run) => run.arm === arm),
    ),
  );

  const baseline = summaries.find((summary) => summary.arm === "baseline");

  const readings =
    baseline === undefined
      ? []
      : summaries.flatMap((summary) => (summary === baseline ? [] : [reading(baseline, summary)]));

  return { runs, summaries, readings };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: "boolean", default: false } },
  });

  const out = positionals[0];

  if (out === undefined) {
    console.error("usage: node evals/implement-chunk/grade.ts <out> [--json]");
    process.exit(2);
  }

  const graded = await gradeDirectory(out);

  writeAtomically(join(out, "grade.json"), `${JSON.stringify(graded, null, 2)}\n`);

  if (values.json) {
    console.log(JSON.stringify(graded, null, 2));

    return;
  }

  const lines = [
    ...graded.runs.flatMap(runLines),
    "",
    ...graded.summaries.flatMap(summaryLines),
    "",
    ...graded.readings.flatMap((entry) => [
      entry.sentence,
      ...entry.comparisons.map(
        (comparison) => `   ${comparison.name}: ${comparison.verdict} (${comparison.detail})`,
      ),
    ]),
  ];

  if (graded.runs.length === 0) lines.push(`no finished runs (run.json) under ${out}`);

  if (graded.runs.some((run) => !isValid(run)))
    lines.push(
      "",
      "WARNING: runs marked WRONG HARNESS or INVALID are excluded from the arm summaries.",
    );

  console.log(lines.join("\n"));
}

if (import.meta.main) await main();
