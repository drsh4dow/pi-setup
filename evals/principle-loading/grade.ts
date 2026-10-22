#!/usr/bin/env node
// Grades candidate sessions: which principle skills each run read, and whether it read them
// before its first file edit. Usage: node evals/principle-loading/grade.ts <results-dir>

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Schema } from "effect";

export const PrincipleName = Schema.TemplateLiteral(["principle-", Schema.String]);

export type PrincipleName = typeof PrincipleName.Type;

export type LoadChannel = "read" | "codemode read" | "bash";

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

// Only the argument fields grading reads. Struct decoding ignores the rest.
const ToolArgs = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
});

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: ToolArgs,
});

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const OtherPart = Schema.Struct({ type: Schema.String });

const AssistantLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Union([ToolCallPart, TextPart, OtherPart])),
    stopReason: Schema.optionalKey(Schema.String),
  }),
});

const ToolResultLine = Schema.Struct({
  type: Schema.Literal("message"),
  message: Schema.Struct({
    role: Schema.Literal("toolResult"),
    toolCallId: Schema.String,
    isError: Schema.optionalKey(Schema.Boolean),
    details: Schema.optionalKey(Schema.Unknown),
  }),
});

const OtherLine = Schema.Struct({ type: Schema.String });

const decodeSessionLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([AssistantLine, ToolResultLine, OtherLine])),
);

// Codemode records each tool call its script made. It truncates long argument JSON, so the
// arguments stay a string: a skill path sits near the start, where truncation cannot reach it.
const decodeCodemodeDetails = Schema.decodeUnknownSync(
  Schema.Struct({
    calls: Schema.Array(
      Schema.Struct({ name: Schema.String, args: Schema.String, status: Schema.String }),
    ),
  }),
);

const decodePrincipleName = Schema.decodeUnknownSync(PrincipleName);

interface Operation {
  readonly tool: string;
  /** The read path or bash command, or a nested call's raw argument JSON. */
  readonly argumentText: string;
  readonly succeeded: boolean;
  readonly nested: boolean;
}

const SKILL_FILE = /skills\/(principle-[a-z0-9-]+)\/SKILL\.md/g;

// A bash command counts as a load only when it prints the file, not when it lists or greps it.
const BASH_FILE_PRINTER = /\b(cat|head|sed|bat|less)\b/;

const MUTATING_TOOLS = new Set(["edit", "write"]);

type SessionLine = ReturnType<typeof decodeSessionLine>;

/** The session's tool operations in execution order, with codemode scripts expanded. */
function operations(lines: readonly SessionLine[]): Operation[] {
  const calls = new Map<string, typeof ToolCallPart.Type>();
  const result: Operation[] = [];

  for (const line of lines) {
    if (Schema.is(AssistantLine)(line)) {
      for (const part of line.message.content) {
        if (Schema.is(ToolCallPart)(part)) calls.set(part.id, part);
      }

      continue;
    }

    if (!Schema.is(ToolResultLine)(line)) continue;

    const call = calls.get(line.message.toolCallId);

    if (!call) continue;

    if (call.name !== "codemode") {
      result.push({
        tool: call.name,
        argumentText: directArgumentText(call),
        succeeded: line.message.isError !== true,
        nested: false,
      });

      continue;
    }

    // A script that failed before calling any tool records no details.
    const details = line.message.details;

    const nestedCalls =
      details === undefined || details === null ? [] : decodeCodemodeDetails(details).calls;

    for (const nested of nestedCalls) {
      result.push({
        tool: nested.name,
        argumentText: nested.args,
        succeeded: nested.status === "ok",
        nested: true,
      });
    }
  }

  return result;
}

function directArgumentText(call: typeof ToolCallPart.Type): string {
  if (call.name === "read") return call.arguments.path ?? "";

  return call.arguments.command ?? "";
}

/** The text an operation exposes skill paths through: a read's path, or a printing bash command. */
function loadingText(operation: Operation): string {
  if (!operation.succeeded) return "";

  if (operation.tool === "read") return operation.argumentText;

  if (operation.tool === "bash" && BASH_FILE_PRINTER.test(operation.argumentText)) {
    return operation.argumentText;
  }

  return "";
}

function channelOf(operation: Operation): LoadChannel {
  if (operation.tool === "bash") return "bash";

  return operation.nested ? "codemode read" : "read";
}

function loadedPrinciples(operation: Operation): PrincipleName[] {
  return [...loadingText(operation).matchAll(SKILL_FILE)].map((match) =>
    decodePrincipleName(match[1]),
  );
}

function finalAssistantText(lines: readonly SessionLine[]): string {
  for (const line of lines.toReversed()) {
    if (!Schema.is(AssistantLine)(line)) continue;

    const texts = line.message.content.flatMap((part) =>
      Schema.is(TextPart)(part) ? [part.text] : [],
    );

    if (texts.length > 0) return texts.join("\n");
  }

  return "";
}

export function gradeSession(jsonl: string): SessionGrade {
  const lines = jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decodeSessionLine(line));

  const ops = operations(lines);
  const loads: PrincipleLoad[] = [];
  let firstMutationStep: number | undefined;

  for (const [step, operation] of ops.entries()) {
    for (const principle of loadedPrinciples(operation)) {
      if (!loads.some((load) => load.principle === principle)) {
        loads.push({ principle, step, channel: channelOf(operation) });
      }
    }

    if (
      firstMutationStep === undefined &&
      operation.succeeded &&
      MUTATING_TOOLS.has(operation.tool)
    ) {
      firstMutationStep = step;
    }
  }

  const stopReasons = lines.flatMap((line) =>
    Schema.is(AssistantLine)(line) && line.message.stopReason !== undefined
      ? [line.message.stopReason]
      : [],
  );

  return {
    loads,
    firstMutationStep,
    steps: ops.length,
    lastStopReason: stopReasons.at(-1),
    finalText: finalAssistantText(lines),
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
    "| Scenario | Model | Trial | Status | Target | Loaded principles (step) | First edit | Secs |",
  );
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const run of graded) {
    const loads = run.grade?.loads
      .map((load) => `${load.principle.replace("principle-", "")}@${load.step}`)
      .join(", ");

    out.push(
      `| ${run.run.target} | ${run.run.model} | ${run.run.trial} | ${run.invalid ?? "ok"} | ${targetCell(run)} | ${loads || "none"} | ${run.grade?.firstMutationStep ?? "–"} | ${Math.round(run.run.durationMs / 1000)} |`,
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
