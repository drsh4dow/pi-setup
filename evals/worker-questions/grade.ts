#!/usr/bin/env node
// Grades every run under a results directory and prints the scenario × arm table, the
// pre-registered decision rule with its inputs and verdict, C against A, and C+push against C on
// S9. Writes grades.json and report.md there.
//
//   node evals/worker-questions/grade.ts <results-dir> [--judge-model anthropic/claude-opus-5-5] [--concurrency 4]
//
// Ask classifications are cached in each run's judge.json; delete it to reclassify.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cachedJudge, piJudge, type Judge } from "../harness-lessons/judge.ts";
import type { Metric } from "../harness-lessons/metrics.ts";
import { runPool } from "../lib/pool.ts";
import {
  correctRate,
  mean,
  median,
  RULE_TEXT,
  verdict,
  type RuleRun,
  type Verdict,
} from "./decision.ts";
import { decodeRunRecord, type RunRecord } from "./record.ts";
import { runMetrics, validity, type GradedAsk, type Validity } from "./run-metrics.ts";
import type { ArmId, ScenarioId } from "./scenario.ts";
import { scenarioById, scenarios } from "./scenarios.ts";

export interface GradedRun {
  readonly dir: string;
  readonly record: RunRecord;
  readonly validity: Validity;
  readonly metrics: Readonly<Record<string, Metric>>;
  readonly asks: readonly GradedAsk[];
}

export async function gradeDirectory(
  dir: string,
  judgeModel: string,
  judge: Judge,
): Promise<GradedRun> {
  const record = decodeRunRecord(readFileSync(join(dir, "run.json"), "utf8"));
  const status = validity(record);

  if (status.kind === "invalid") return { dir, record, validity: status, metrics: {}, asks: [] };

  const graded = await runMetrics({
    dir,
    record,
    scenario: scenarioById(record.scenario),
    judge: cachedJudge({ judge, model: judgeModel, file: join(dir, "judge.json") }),
  });

  return { dir, record, validity: status, metrics: graded.metrics, asks: graded.asks };
}

const numberOf = (metric: Metric | undefined) =>
  metric?.kind === "count" ? metric.value : undefined;

/** A valid run whose `correct` is decided, in the shape the rule reads. */
export function ruleRun(run: GradedRun): RuleRun | undefined {
  const correct = run.metrics.correct;

  if (run.validity.kind !== "valid" || correct?.kind !== "flag") return undefined;

  const worker = numberOf(run.metrics.workerCost);
  const parent = numberOf(run.metrics.parentCost);

  return {
    scenario: run.record.scenario,
    family: scenarioById(run.record.scenario).family,
    arm: run.record.arm,
    correct: correct.value,
    timeToCorrect: numberOf(run.metrics.timeToCorrect) ?? Infinity,
    noiseAsks: numberOf(run.metrics.noiseAsks),
    totalCost: worker === undefined || parent === undefined ? undefined : worker + parent,
  };
}

function fmt(number: number | undefined, digits = 0): string {
  if (number === undefined) return "–";

  return Number.isFinite(number) ? number.toFixed(digits) : "∞";
}

function meanOf(runs: readonly GradedRun[], name: string): number | undefined {
  return mean(
    runs.flatMap((run) => {
      const known = numberOf(run.metrics[name]);

      return known === undefined ? [] : [known];
    }),
  );
}

function verdictLines(candidate: ArmId, result: Verdict): string[] {
  if (result.kind === "insufficient data") {
    return [
      `- **${candidate} vs C: insufficient data.** Cells under 3 graded runs: ${result.thinCells.join(", ")}.`,
    ];
  }

  return [
    `- **${candidate} vs C: ${result.kind}.**`,
    ...result.checks.map(
      (check) => `  - ${check.pass ? "pass" : "fail"}: ${check.name} (${check.detail})`,
    ),
  ];
}

function comparison(
  rules: readonly RuleRun[],
  scenarioIds: readonly ScenarioId[],
  left: ArmId,
  right: ArmId,
): string[] {
  return scenarioIds.flatMap((scenario) => {
    const of = (arm: ArmId) => rules.filter((run) => run.scenario === scenario && run.arm === arm);
    const [a, b] = [of(left), of(right)];

    if (a.length === 0 && b.length === 0) return [];

    return [
      `| ${scenario} | ${a.length} / ${b.length} | ${fmt(correctRate(a), 2)} / ${fmt(correctRate(b), 2)} | ${fmt(median(a.map((run) => run.timeToCorrect)))} / ${fmt(median(b.map((run) => run.timeToCorrect)))} |`,
    ];
  });
}

export function report(graded: readonly GradedRun[]): string {
  const rules = graded.flatMap((run) => {
    const rule = ruleRun(run);

    return rule === undefined ? [] : [rule];
  });

  const out = [
    "# Worker questions",
    "",
    `Runs: ${graded.length}, graded (valid, correct decided): ${rules.length}.`,
    "",
  ];

  out.push(
    "## Scenario × arm",
    "",
    "n counts graded runs. Medians and means are over graded runs with the metric known; timeToCorrect is ∞ for a run never correct. Costs are dollars per run.",
    "",
    "| scenario | arm | n | correct | median timeToCorrect s | asks | noise+repo asks | rounds | idle s | scope violations | worker $ | parent $ |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const scenario of scenarios) {
    for (const arm of scenario.arms) {
      const runs = graded.filter(
        (run) =>
          run.record.scenario === scenario.id &&
          run.record.arm === arm &&
          ruleRun(run) !== undefined,
      );

      const ruleRuns = rules.filter((run) => run.scenario === scenario.id && run.arm === arm);

      if (graded.every((run) => run.record.scenario !== scenario.id || run.record.arm !== arm))
        continue;

      out.push(
        `| ${scenario.id} | ${arm} | ${runs.length} | ${fmt(correctRate(ruleRuns), 2)} | ${fmt(median(ruleRuns.map((run) => run.timeToCorrect)))} | ${fmt(meanOf(runs, "asks"), 1)} | ${fmt(meanOf(runs, "noiseAsks"), 2)} | ${fmt(meanOf(runs, "rounds"), 1)} | ${fmt(meanOf(runs, "idle"))} | ${fmt(meanOf(runs, "scopeViolations"), 1)} | ${fmt(meanOf(runs, "workerCost"), 2)} | ${fmt(meanOf(runs, "parentCost"), 3)} |`,
      );
    }
  }

  const scenarioIds = scenarios.map((scenario) => scenario.id);

  out.push(
    "",
    "## Decision rule (pre-registered)",
    "",
    RULE_TEXT,
    "",
    ...verdictLines("R", verdict({ runs: rules, candidate: "R", scenarioIds })),
    ...verdictLines("L", verdict({ runs: rules, candidate: "L", scenarioIds })),
    "",
  );

  out.push(
    "## C vs A: the hardened brief alone",
    "",
    "| scenario | n C / A | correct C / A | median timeToCorrect s C / A |",
    "| --- | --- | --- | --- |",
    ...comparison(rules, scenarioIds, "C", "A"),
    "",
  );

  out.push(
    "## C+push vs C on S9",
    "",
    "| scenario | n C+push / C | correct C+push / C | median timeToCorrect s C+push / C |",
    "| --- | --- | --- | --- |",
    ...comparison(rules, ["s9-order"], "C+push", "C"),
    "",
  );

  const pushed = graded.flatMap((run) =>
    run.record.arm === "C+push" && run.metrics.pushFollowed !== undefined
      ? [`- ${label(run)}: pushFollowed ${describe(run.metrics.pushFollowed)}`]
      : [],
  );

  if (pushed.length > 0) out.push(...pushed, "");

  const unknowns = graded.flatMap((run) =>
    Object.entries(run.metrics).flatMap(([name, metric]) =>
      metric.kind === "unknown" ? [`- ${label(run)} ${name}: ${metric.reason}`] : [],
    ),
  );

  if (unknowns.length > 0) out.push("## Unknown metrics", "", ...unknowns, "");

  const invalid = graded.filter((run) => run.validity.kind === "invalid");

  if (invalid.length > 0)
    out.push(
      "## Invalid runs",
      "",
      ...invalid.map(
        (run) => `- ${label(run)}: ${run.validity.kind === "invalid" ? run.validity.reason : ""}`,
      ),
      "",
    );

  const asks = graded.flatMap((run) =>
    run.asks.map(
      (ask) =>
        `- ${label(run)} (${ask.via}) **${ask.classification.kind === "classified" ? ask.classification.category : "unknown"}**: ${ask.question.replaceAll("\n", " ").slice(0, 300)} → ${ask.answer.slice(0, 200)}`,
    ),
  );

  if (asks.length > 0) out.push("## Asks", "", ...asks, "");

  return `${out.join("\n")}\n`;
}

function describe(metric: Metric): string {
  if (metric.kind === "unknown") return `unknown (${metric.reason})`;

  return `${String(metric.value)} (${metric.evidence})`;
}

const label = (run: GradedRun) =>
  `${run.record.scenario} ${run.record.arm} ${run.record.model} t${run.record.trial}`;

function runDirectories(resultsDir: string): string[] {
  return readdirSync(resultsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "run.json")
    .map((entry) => entry.parentPath)
    .toSorted();
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "judge-model": { type: "string", default: "anthropic/claude-opus-5-5" },
      concurrency: { type: "string", default: "4" },
    },
  });

  const resultsDir = positionals[0];

  if (resultsDir === undefined || !existsSync(resultsDir)) {
    console.error(
      "usage: node evals/worker-questions/grade.ts <results-dir> [--judge-model <model>] [--concurrency 4]",
    );
    process.exit(2);
  }

  const judge = piJudge(values["judge-model"]);
  const graded: GradedRun[] = [];

  await runPool(runDirectories(resultsDir), Number(values.concurrency), async (dir) => {
    graded.push(await gradeDirectory(dir, values["judge-model"], judge));
  });

  graded.sort((a, b) => a.dir.localeCompare(b.dir));

  const markdown = report(graded);

  writeFileSync(join(resultsDir, "grades.json"), `${JSON.stringify(graded, null, 2)}\n`);
  writeFileSync(join(resultsDir, "report.md"), markdown);
  process.stdout.write(markdown);
}

if (import.meta.main) await main();
