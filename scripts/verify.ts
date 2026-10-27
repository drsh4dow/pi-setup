// `node scripts/verify.ts <task> [vp run options]` runs that task's checks and, when one fails,
// ends with which task failed and what it printed. The task runner kills the tasks still
// running once one fails, and each of those exits 137, as a real failure can, so this reads
// the run's details and lists those kills apart from the failure.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

export interface TaskOutcome {
  // The [n] the details print, which counts commands in the order they finished.
  readonly order: number;
  // The `<package>#<task>` label.
  readonly task: string;
  readonly exitCode: number;
}

type NonEmpty<T> = readonly [T, ...T[]];

export type VerifyResult =
  | { readonly kind: "passed" }
  | {
      readonly kind: "failed";
      readonly failed: NonEmpty<TaskOutcome>;
      readonly stopped: readonly TaskOutcome[];
    };

type FailedVerify = Extract<VerifyResult, { kind: "failed" }>;

const KILLED = 128 + constants.signals.SIGKILL;

const DETAILS_LINE = /^\s*\[(\d+)\] (\S+?): .* (?:✓|✗ \(exit code: (\d+)\))$/u;

const LABELED_LINE = /^\[([^\]\s]+#[^\]\s]+)\] ?(.*)$/su;

// When a run ran at least one task, `vp run -v` ends it with its details, which open with a
// line of ━.
const DETAILS_RULE = /^━+$/u;

const STATISTICS_LINE = /^Statistics: /u;

export function parseDetails(details: string): TaskOutcome[] {
  const outcomes: TaskOutcome[] = [];

  for (const line of stripVTControlCharacters(details).split("\n")) {
    const match = DETAILS_LINE.exec(line.trimEnd());

    if (match === null) continue;

    const [, order, task, exitCode] = match;

    outcomes.push({
      order: Number(order),
      task,
      exitCode: exitCode === undefined ? 0 : Number(exitCode),
    });
  }

  return outcomes;
}

// The first failure is real whatever its exit code, so a task killed from outside verify
// still fails it. A 137 after that is the task runner stopping a sibling.
export function classifyOutcomes(outcomes: readonly TaskOutcome[]): VerifyResult {
  const unsuccessful = outcomes
    .filter((outcome) => outcome.exitCode !== 0)
    .toSorted((left, right) => left.order - right.order);

  const [first, ...later] = unsuccessful;

  if (first === undefined) return { kind: "passed" };

  return {
    kind: "failed",
    failed: [first, ...later.filter((outcome) => outcome.exitCode !== KILLED)],
    stopped: later.filter((outcome) => outcome.exitCode === KILLED),
  };
}

export interface TaskLine {
  // The `<package>#<task>` label, or null for a line the task runner printed itself.
  readonly task: string | null;
  readonly text: string;
}

export function taskLine(line: string): TaskLine {
  const plain = stripVTControlCharacters(line);
  const match = LABELED_LINE.exec(plain);

  if (match === null) return { task: null, text: plain };

  return { task: match[1], text: match[2] };
}

function withoutPackage(task: string) {
  return task.slice(task.indexOf("#") + 1);
}

export function failureReport(
  result: FailedVerify,
  linesByTask: ReadonlyMap<string, readonly string[]>,
): string[] {
  const report: string[] = [];

  for (const failure of result.failed) {
    const name = withoutPackage(failure.task);

    report.push(`verify: ${name} failed (exit ${failure.exitCode})`);

    const printed = linesByTask.get(failure.task) ?? [];

    if (printed.length === 0) report.push(`verify: ${name} printed nothing`);

    report.push(...printed);
  }

  const stopped = [...new Set(result.stopped.map((outcome) => withoutPackage(outcome.task)))];

  if (stopped.length > 0) report.push(`verify: stopped after the failure: ${stopped.join(", ")}`);

  return report;
}

export function verifyReport(
  status: number,
  outcomes: readonly TaskOutcome[],
  linesByTask: ReadonlyMap<string, readonly string[]>,
): string[] {
  const result = classifyOutcomes(outcomes);

  if (result.kind === "passed") {
    return [
      `verify: failed (exit ${status}), but its run details list no failed command. Read the task output above.`,
    ];
  }

  return failureReport(result, linesByTask);
}

// Text verify can read from: the details list each command, or at least their statistics.
function isDetails(held: readonly string[]) {
  return held.some((line) => STATISTICS_LINE.test(line) || DETAILS_LINE.test(line.trimEnd()));
}

// The details end the run, so a task line after a rule of ━ means that rule opened no details,
// and so does held text that ends the run with nothing verify can read, such as a startup error.
async function relay(
  input: Readable,
  sink: Writable,
  linesByTask: Map<string, string[]>,
): Promise<string[] | null> {
  let details: string[] | null = null;
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const { task, text } = taskLine(line);

    if (task === null) {
      if (details === null && DETAILS_RULE.test(text)) details = [];

      if (details === null) sink.write(`${text}\n`);
      else details.push(text);
      continue;
    }

    for (const held of details ?? []) sink.write(`${held}\n`);
    details = null;

    sink.write(`${text}\n`);

    const printed = linesByTask.get(task);

    if (printed === undefined) linesByTask.set(task, [text]);
    else printed.push(text);
  }

  if (details === null || isDetails(details)) return details;

  for (const held of details) sink.write(`${held}\n`);

  return null;
}

export type InnerRun =
  | { readonly kind: "run"; readonly args: readonly string[] }
  | { readonly kind: "usage" };

// The task's command names the inner task. `vp run` appends the options given after the outer
// task, such as --no-cache. They belong to the inner run, because the inner run owns the cache.
// -v ends the inner run with its details. `vp run --last-details` would read the details of
// whichever run in the workspace ended last.
export function innerRunArgs(argv: readonly string[]): InnerRun {
  const [task, ...options] = argv;

  if (task === undefined || task.startsWith("-")) return { kind: "usage" };

  return { kind: "run", args: ["run", "--log", "labeled", "-v", ...options, task] };
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null) {
  if (code !== null) return code;

  if (signal !== null) return 128 + constants.signals[signal];

  return 1;
}

async function main() {
  const inner = innerRunArgs(process.argv.slice(2));

  if (inner.kind === "usage") {
    console.error("usage: node scripts/verify.ts <task> [vp run options]");

    return 2;
  }

  const run = spawn("vp", inner.args, { stdio: ["inherit", "pipe", "pipe"] });

  const closed = new Promise<number>((resolve, reject) => {
    run.once("error", reject);
    run.once("close", (code, signal) => resolve(exitStatus(code, signal)));
  });

  const linesByTask = new Map<string, string[]>();

  const [status, detailsOut, detailsErr] = await Promise.all([
    closed,
    relay(run.stdout, process.stdout, linesByTask),
    relay(run.stderr, process.stderr, linesByTask),
  ]);

  const details = detailsOut ?? detailsErr;

  if (details === null) {
    if (status !== 0) {
      console.log(
        `\nverify: failed (exit ${status}), but the run printed no details, so verify cannot tell which task failed. Read the output above.`,
      );
    }

    return status;
  }

  const statistics = details.find((line) => STATISTICS_LINE.test(line));

  if (statistics !== undefined) console.log(statistics);

  if (status === 0) return status;

  console.log(
    ["", ...verifyReport(status, parseDetails(details.join("\n")), linesByTask)].join("\n"),
  );

  return status;
}

if (import.meta.main) process.exitCode = await main();
