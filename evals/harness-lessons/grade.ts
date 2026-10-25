#!/usr/bin/env node
// Grades every run under a results directory: each scenario's metrics from the session, the
// final working directory, and the records setup kept, plus the judge for the metrics that need
// judgment. Writes grades.json and report.md there and prints the report.
//
//   node evals/harness-lessons/grade.ts <results-dir> [--judge-model anthropic/claude-opus-5-5] [--concurrency 4]
//
// Judge answers are cached in each run's judge.json; delete it to rejudge a run. A judge model
// named gemini-api/<model> is called through the Gemini API (GEMINI_API_KEY) instead of pi.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { parseSession, sinceLastUserMessage, type Session } from "../lib/session.ts";
import { runPool } from "../lib/pool.ts";
import { graders } from "./graders.ts";
import { cachedJudge, judgeFor, redactingJudge, type Judge } from "./judge.ts";
import { disagreements, type Metric, type Outcome } from "./metrics.ts";
import { decodeRunRecord, type RunRecord } from "./record.ts";
import { scenarioById, scenarios, type Scenario } from "./scenarios.ts";
import { decodeSetupSnapshot } from "./workdir.ts";

export type Validity =
  | { readonly kind: "valid"; readonly note: string | null }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Whether a run counts. It does not when setup failed, it timed out, it exited non-zero, it left
 * no session, or its last stop reason is not `stop`. A scenario that ends by timeout counts a
 * timeout whose agent had finished its turn and was waiting on its watcher.
 */
export function validity(
  run: RunRecord,
  session: Session | undefined,
  scenario: Scenario,
): Validity {
  if (run.setupProblems.length > 0)
    return { kind: "invalid", reason: `setup failed: ${run.setupProblems.join("; ")}` };

  if (scenario.endsByTimeout && run.timedOut && session?.lastStopReason === "stop") {
    return { kind: "valid", note: "ended by the timeout while waiting on its watcher" };
  }

  if (run.timedOut) return { kind: "invalid", reason: "timed out" };

  if (run.exitCode !== 0) return { kind: "invalid", reason: `exit ${run.exitCode ?? run.signal}` };

  if (session === undefined) return { kind: "invalid", reason: "no session file" };

  if (session.lastStopReason !== "stop") {
    return { kind: "invalid", reason: `last stop reason ${session.lastStopReason ?? "none"}` };
  }

  return { kind: "valid", note: null };
}

export interface GradedRun {
  readonly dir: string;
  readonly run: RunRecord;
  readonly validity: Validity;
  readonly primary: Outcome;
  readonly metrics: Readonly<Record<string, Metric>>;
  readonly disagreements: readonly string[];
  readonly finalText: string;
  readonly judgeAnswers: unknown;
}

export async function gradeDirectory(
  dir: string,
  judgeModel: string,
  judge: Judge,
): Promise<GradedRun> {
  const run = decodeRunRecord(readFileSync(join(dir, "run.json"), "utf8"));
  const scenario = scenarioById(run.scenario);
  const sessionPath = join(dir, "session.jsonl");

  // A run that continued a seeded chat is graded on its own turn only.
  const own = (jsonl: string) =>
    scenario.seededChat === null ? jsonl : sinceLastUserMessage(jsonl);

  const session = existsSync(sessionPath)
    ? parseSession(own(readFileSync(sessionPath, "utf8")))
    : undefined;

  const status = validity(run, session, scenario);
  const judgeFile = join(dir, "judge.json");
  const base = { dir, run, validity: status, finalText: session?.finalText ?? "" };

  if (status.kind === "invalid" || session === undefined) {
    return { ...base, primary: "unknown", metrics: {}, disagreements: [], judgeAnswers: null };
  }

  if (!existsSync(run.workdir)) {
    return {
      ...base,
      primary: "unknown",
      metrics: { workdir: { kind: "unknown", reason: `${run.workdir} no longer exists` } },
      disagreements: [],
      judgeAnswers: null,
    };
  }

  const graded = await graders[run.scenario]({
    run,
    setup: decodeSetupSnapshot(readFileSync(join(dir, "setup.json"), "utf8")),
    session,
    outputDir: dir,
    judge: redactingJudge(
      cachedJudge({ judge, model: judgeModel, file: judgeFile }),
      run.armRoot,
      "<harness>",
    ),
  });

  return {
    ...base,
    primary: graded.primary,
    metrics: graded.metrics,
    disagreements: disagreements(graded),
    judgeAnswers: existsSync(judgeFile) ? JSON.parse(readFileSync(judgeFile, "utf8")) : null,
  };
}

function rate(runs: readonly GradedRun[], pick: (run: GradedRun) => Metric | undefined): string {
  const metrics = runs.flatMap((run) => {
    const metric = pick(run);

    return metric === undefined ? [] : [metric];
  });

  const unknowns = metrics.filter((metric) => metric.kind === "unknown").length;
  const suffix = unknowns > 0 ? ` (+${unknowns}?)` : "";
  const counts = metrics.flatMap((metric) => (metric.kind === "count" ? [metric.value] : []));

  if (counts.length > 0) {
    return `avg ${(counts.reduce((sum, value) => sum + value, 0) / counts.length).toFixed(1)}${suffix}`;
  }

  const flags = metrics.flatMap((metric) => (metric.kind === "flag" ? [metric.value] : []));

  if (flags.length === 0) return unknowns > 0 ? `?${unknowns}` : "–";

  return `${flags.filter(Boolean).length}/${flags.length}${suffix}`;
}

function primaryRate(runs: readonly GradedRun[]): string {
  const passed = runs.filter((run) => run.primary === "pass").length;
  const decided = runs.filter((run) => run.primary !== "unknown").length;
  const unknowns = runs.length - decided;

  return `${decided === 0 ? "–" : `${passed}/${decided}`}${unknowns > 0 ? ` (+${unknowns}?)` : ""}`;
}

function label(run: GradedRun): string {
  return `${run.run.scenario} ${run.run.arm} ${run.run.model} t${run.run.trial}`;
}

export function report(graded: readonly GradedRun[]): string {
  const valid = graded.filter((run) => run.validity.kind === "valid");
  const models = new Set(graded.map((run) => run.run.model));
  const out = ["# Harness lessons", "", `Runs: ${graded.length}, valid: ${valid.length}.`, ""];

  out.push(
    "Rates are over valid runs: passed/decided, `(+n?)` counts runs the metric could not decide.",
    "",
  );

  for (const scenario of scenarios) {
    const runs = graded.filter((run) => run.run.scenario === scenario.id);

    if (runs.length === 0) continue;

    const metricNames = [
      ...new Set(
        valid
          .filter((run) => run.run.scenario === scenario.id)
          .flatMap((run) => Object.keys(run.metrics)),
      ),
    ];

    const groups = [
      ...new Set(
        runs.map((run) => (models.size > 1 ? `${run.run.arm} ${run.run.model}` : run.run.arm)),
      ),
    ].toSorted();

    out.push(`## ${scenario.id}`, "");
    out.push(`| arm | valid | primary | ${metricNames.join(" | ")} |`);
    out.push(`| --- | --- | --- | ${metricNames.map(() => "---").join(" | ")} |`);

    for (const group of groups) {
      const inGroup = runs.filter(
        (run) => (models.size > 1 ? `${run.run.arm} ${run.run.model}` : run.run.arm) === group,
      );

      const validInGroup = inGroup.filter((run) => run.validity.kind === "valid");
      const cells = metricNames.map((name) => rate(validInGroup, (run) => run.metrics[name]));

      out.push(
        `| ${group} | ${validInGroup.length}/${inGroup.length} | ${primaryRate(validInGroup)} | ${cells.join(" | ")} |`,
      );
    }

    out.push("");
  }

  const disagreeing = valid.filter((run) => run.disagreements.length > 0);

  if (disagreeing.length > 0) {
    out.push("## Metric and judge disagreements", "");

    for (const run of disagreeing) out.push(`- ${label(run)}: ${run.disagreements.join("; ")}`);

    out.push("");
  }

  const undecided = valid.flatMap((run) =>
    Object.entries(run.metrics).flatMap(([name, metric]) =>
      metric.kind === "unknown" ? [`- ${label(run)} ${name}: ${metric.reason}`] : [],
    ),
  );

  if (undecided.length > 0) out.push("## Undecided metrics", "", ...undecided, "");

  const invalid = graded.filter((run) => run.validity.kind === "invalid");

  if (invalid.length > 0) {
    out.push("## Invalid runs", "");

    for (const run of invalid)
      out.push(`- ${label(run)}: ${run.validity.kind === "invalid" ? run.validity.reason : ""}`);

    out.push("");
  }

  const notes = valid.filter((run) => run.validity.kind === "valid" && run.validity.note !== null);

  if (notes.length > 0) {
    out.push("## Notes", "");

    for (const run of notes)
      out.push(`- ${label(run)}: ${run.validity.kind === "valid" ? run.validity.note : ""}`);

    out.push("");
  }

  return `${out.join("\n")}\n`;
}

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

  if (!resultsDir) {
    console.error(
      "usage: node evals/harness-lessons/grade.ts <results-dir> [--judge-model <model>] [--concurrency 4]",
    );
    process.exit(2);
  }

  const judge = judgeFor(values["judge-model"]);
  const graded: GradedRun[] = [];

  await runPool(runDirectories(resultsDir), Number(values.concurrency), async (dir) => {
    graded.push(await gradeDirectory(dir, values["judge-model"], judge));
  });

  graded.sort((a, b) => a.dir.localeCompare(b.dir));

  const markdown = report(graded);

  writeFileSync(join(resultsDir, "grades.json"), `${JSON.stringify(graded, null, 2)}\n`);
  writeFileSync(join(resultsDir, "report.md"), markdown);
  process.stdout.write(markdown);
  process.stdout.write(`\nWrote ${relative(process.cwd(), join(resultsDir, "grades.json"))}\n`);
}

if (import.meta.main) await main();
