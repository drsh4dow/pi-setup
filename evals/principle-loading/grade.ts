#!/usr/bin/env node
// Grades candidate sessions: which principle skills each run read, and whether it read them
// before its first file edit. Usage: node evals/principle-loading/grade.ts <results-dir>

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Schema } from "effect";
import { parseSession, skillLoads, type LoadChannel } from "../lib/session.ts";

export const PrincipleName = Schema.TemplateLiteral(["principle-", Schema.String]);

export type PrincipleName = typeof PrincipleName.Type;

export interface PrincipleLoad {
  readonly principle: PrincipleName;
  /** Index of the tool operation that loaded it, counting codemode's nested calls. */
  readonly step: number;
  readonly channel: LoadChannel;
}

export interface SessionGrade {
  /** First load of each principle, in load order. */
  readonly loads: readonly PrincipleLoad[];
  /** Step of the first successful edit or write, absent when the run changed no file that way. */
  readonly firstMutationStep: number | undefined;
  readonly steps: number;
  readonly lastStopReason: string | undefined;
  readonly finalText: string;
}

const decodePrincipleName = Schema.decodeUnknownSync(PrincipleName);

const MUTATING_TOOLS = new Set(["edit", "write"]);

export function gradeSession(jsonl: string): SessionGrade {
  const session = parseSession(jsonl);

  const loads = skillLoads(session.operations).flatMap((load) =>
    Schema.is(PrincipleName)(load.skill)
      ? [{ principle: decodePrincipleName(load.skill), step: load.step, channel: load.channel }]
      : [],
  );

  const firstMutation = session.operations.find(
    (operation) => operation.succeeded && MUTATING_TOOLS.has(operation.tool),
  );

  return {
    loads,
    firstMutationStep: firstMutation?.step,
    steps: session.operations.length,
    lastStopReason: session.lastStopReason,
    finalText: session.finalText,
  };
}

export const RunRecord = Schema.Struct({
  target: PrincipleName,
  model: Schema.String,
  trial: Schema.Int,
  workdir: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Finite,
  session: Schema.NullOr(Schema.String),
  /** Changed files plus new commits after the run. Absent in records written before it was measured. */
  projectChanges: Schema.optionalKey(Schema.Int),
});

export type RunRecord = typeof RunRecord.Type;

const decodeRunRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord));

export interface GradedRun {
  readonly run: RunRecord;
  readonly grade: SessionGrade | undefined;
  /** Why the run does not count, absent when it does. */
  readonly invalid: string | undefined;
  readonly targetLoaded: boolean;
  /** Loaded before the first edit or write, or the run never edited. */
  readonly targetLoadedEarly: boolean;
  /** The run left the project as setup made it, usually because it stopped to ask. Absent when unmeasured. */
  readonly changedNothing: boolean | undefined;
}

function invalidReason(run: RunRecord, grade: SessionGrade | undefined): string | undefined {
  if (run.timedOut) return "timed out";

  if (run.exitCode !== 0) return `exit ${run.exitCode ?? run.signal}`;

  if (!grade) return "no session file";

  if (grade.lastStopReason !== "stop") return `last stop reason ${grade.lastStopReason ?? "none"}`;

  return undefined;
}

export function gradeRun(run: RunRecord, sessionJsonl: string | undefined): GradedRun {
  const grade = sessionJsonl === undefined ? undefined : gradeSession(sessionJsonl);
  const load = grade?.loads.find((candidate) => candidate.principle === run.target);
  const firstMutation = grade?.firstMutationStep;
  const early = load !== undefined && (firstMutation === undefined || load.step < firstMutation);

  return {
    run,
    grade,
    invalid: invalidReason(run, grade),
    targetLoaded: load !== undefined,
    targetLoadedEarly: early,
    changedNothing: run.projectChanges === undefined ? undefined : run.projectChanges === 0,
  };
}

function runDirectories(resultsDir: string): string[] {
  return readdirSync(resultsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === "run.json")
    .map((entry) => entry.parentPath)
    .toSorted();
}

function fraction(runs: readonly GradedRun[], pick: (run: GradedRun) => boolean): string {
  const valid = runs.filter((run) => run.invalid === undefined);

  if (valid.length === 0) return "–";

  return `${valid.filter(pick).length}/${valid.length}`;
}

function targetCell(run: GradedRun): string {
  if (!run.targetLoaded) return "missed";

  return run.targetLoadedEarly ? "early" : "late";
}

export function report(graded: readonly GradedRun[]): string {
  const models = [...new Set(graded.map((run) => run.run.model))].toSorted();
  const targets = [...new Set(graded.map((run) => run.run.target))].toSorted();
  const valid = graded.filter((run) => run.invalid === undefined);
  const out: string[] = [];

  out.push("# Principle loading", "", `Runs: ${graded.length}, valid: ${valid.length}.`, "");

  out.push("## Target principle loaded (any time / before first edit)", "");
  out.push(`| Scenario | ${models.map((model) => `${model} any | ${model} early`).join(" | ")} |`);
  out.push(`| --- | ${models.map(() => "--- | ---").join(" | ")} |`);

  const cells = (runs: readonly GradedRun[]) =>
    `${fraction(runs, (run) => run.targetLoaded)} | ${fraction(runs, (run) => run.targetLoadedEarly)}`;

  for (const target of targets) {
    const row = models.map((model) =>
      cells(graded.filter((run) => run.run.target === target && run.run.model === model)),
    );

    out.push(`| ${target} | ${row.join(" | ")} |`);
  }

  const totals = models.map((model) => cells(graded.filter((run) => run.run.model === model)));

  out.push(`| **all** | ${totals.join(" | ")} |`, "");

  out.push("## Runs that changed nothing in the project (usually stopped to ask)", "");
  out.push(`| Scenario | ${models.join(" | ")} |`);
  out.push(`| --- | ${models.map(() => "---").join(" | ")} |`);

  const changedNothing = (runs: readonly GradedRun[]) =>
    fraction(
      runs.filter((run) => run.changedNothing !== undefined),
      (run) => run.changedNothing === true,
    );

  for (const target of targets) {
    const row = models.map((model) =>
      changedNothing(graded.filter((run) => run.run.target === target && run.run.model === model)),
    );

    out.push(`| ${target} | ${row.join(" | ")} |`);
  }

  const changedNothingTotals = models.map((model) =>
    changedNothing(graded.filter((run) => run.run.model === model)),
  );

  out.push(`| **all** | ${changedNothingTotals.join(" | ")} |`, "");

  out.push(
    "## Off-target loads (runs that loaded the principle in other scenarios / valid runs of other scenarios)",
    "",
  );
  out.push(`| Principle | ${models.join(" | ")} |`);
  out.push(`| --- | ${models.map(() => "---").join(" | ")} |`);

  const principles = [
    ...new Set(valid.flatMap((run) => run.grade?.loads.map((load) => load.principle) ?? [])),
  ].toSorted();

  for (const principle of principles) {
    const row = models.map((model) => {
      const others = valid.filter((run) => run.run.model === model && run.run.target !== principle);

      const loaded = others.filter((run) =>
        run.grade?.loads.some((load) => load.principle === principle),
      );

      return `${loaded.length}/${others.length}`;
    });

    out.push(`| ${principle} | ${row.join(" | ")} |`);
  }

  out.push("", "## Runs", "");
  out.push(
    "| Scenario | Model | Trial | Status | Target | Loaded principles (step) | First edit | Changes | Secs |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const run of graded) {
    const loads = run.grade?.loads
      .map((load) => `${load.principle.replace("principle-", "")}@${load.step}`)
      .join(", ");

    out.push(
      `| ${run.run.target} | ${run.run.model} | ${run.run.trial} | ${run.invalid ?? "ok"} | ${targetCell(run)} | ${loads || "none"} | ${run.grade?.firstMutationStep ?? "–"} | ${run.run.projectChanges ?? "–"} | ${Math.round(run.run.durationMs / 1000)} |`,
    );
  }

  return `${out.join("\n")}\n`;
}

function main(resultsDir: string) {
  const graded = runDirectories(resultsDir).map((dir) => {
    const record = decodeRunRecord(readFileSync(join(dir, "run.json"), "utf8"));
    const sessionPath = join(dir, "session.jsonl");

    return gradeRun(
      record,
      existsSync(sessionPath) ? readFileSync(sessionPath, "utf8") : undefined,
    );
  });

  const markdown = report(graded);

  writeFileSync(join(resultsDir, "report.md"), markdown);
  writeFileSync(join(resultsDir, "grades.json"), `${JSON.stringify(graded, null, 2)}\n`);
  process.stdout.write(markdown);
  process.stdout.write(`\nWrote ${relative(process.cwd(), join(resultsDir, "report.md"))}\n`);
}

if (import.meta.main) {
  const resultsDir = process.argv[2];

  if (!resultsDir) {
    console.error("usage: node evals/principle-loading/grade.ts <results-dir>");
    process.exit(2);
  }

  main(resultsDir);
}
