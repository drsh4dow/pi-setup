// `node scripts/verify.ts <task>` runs that task's checks and, when one fails, ends with
// which task failed and what it printed. `vp run verify` runs `verify:all` through it, and
// `vp run verify:without-video` runs `verify:checks`. The task runner kills the tasks still running once one fails,
// and each of those exits 137 just like a real failure, so this reads the run's details and
// lists those kills apart from the failure.
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

export interface TaskOutcome {
  // The [n] the details print, which counts commands in the order they finished.
  readonly order: number;
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

// The exit code of a command the task runner stopped with SIGKILL.
const KILLED = 128 + constants.signals.SIGKILL;

// `  [16] pi-dotfiles#test:docs: $ node scripts/verify-docs.ts ✗ (exit code: 1)`
const DETAILS_LINE = /^\s*\[(\d+)\] (\S+?): .* (?:✓|✗ \(exit code: (\d+)\))$/u;

// `[pi-dotfiles#test:docs] docs/development.md: broken local link docs/missing.md`
const LABELED_LINE = /^\[([^\]\s]+#[^\]\s]+)\] ?(.*)$/su;

// The inner run's summary points at `vp run --last-details`, which the outer `vp run verify`
// overwrites with its own single task by the time anyone reads it.
const LAST_DETAILS_HINT = " (Run `vp run --last-details` for full details)";

export function parseLastDetails(details: string): TaskOutcome[] {
  const outcomes: TaskOutcome[] = [];

  for (const line of stripVTControlCharacters(details).split("\n")) {
    const match = DETAILS_LINE.exec(line.trimEnd());

    if (match === null) continue;

    const [, order, task, exitCode] = match;

    if (order === undefined || task === undefined) continue;

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

  if (match?.[1] === undefined) return { task: null, text: plain };

  return { task: match[1], text: match[2] ?? "" };
}

function taskName(task: string) {
  return task.slice(task.indexOf("#") + 1);
}

export function failureReport(
  result: FailedVerify,
  output: ReadonlyMap<string, readonly string[]>,
): string[] {
  const report: string[] = [];

  for (const failure of result.failed) {
    const name = taskName(failure.task);

    report.push(`verify: ${name} failed (exit ${failure.exitCode})`);

    const printed = output.get(failure.task) ?? [];

    if (printed.length === 0) report.push(`verify: ${name} printed nothing`);

    report.push(...printed);
  }

  const stopped = [...new Set(result.stopped.map((outcome) => taskName(outcome.task)))];

  if (stopped.length > 0) report.push(`verify: stopped after the failure: ${stopped.join(", ")}`);

  return report;
}

// Each line goes out as the default interleaved log would print it, and each task's lines
// are kept for the report. Returns whether the run printed its summary, which it does only
// after it ran tasks and wrote the details this script reads.
async function relay(
  input: Readable,
  sink: Writable,
  output: Map<string, string[]>,
): Promise<boolean> {
  let summarized = false;
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const { task, text } = taskLine(line);

    if (task === null) {
      if (text.startsWith("vp run: ")) summarized = true;
      sink.write(`${text.replace(LAST_DETAILS_HINT, "")}\n`);
      continue;
    }

    sink.write(`${text}\n`);

    const printed = output.get(task);

    if (printed === undefined) output.set(task, [text]);
    else printed.push(text);
  }

  return summarized;
}

export type InnerRun =
  | { readonly kind: "run"; readonly args: readonly string[] }
  | { readonly kind: "usage" };

// The task's command names the inner task, and `vp run` appends the options given after
// the outer task, such as --no-cache, which belong to the inner run because it owns the cache.
export function innerRunArgs(argv: readonly string[]): InnerRun {
  const [task, ...options] = argv;

  if (task === undefined || task.startsWith("-")) return { kind: "usage" };

  return { kind: "run", args: ["run", "--log", "labeled", ...options, task] };
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

  const output = new Map<string, string[]>();

  const [status, summarizedOut, summarizedErr] = await Promise.all([
    closed,
    relay(run.stdout, process.stdout, output),
    relay(run.stderr, process.stderr, output),
  ]);

  if (status === 0 || !(summarizedOut || summarizedErr)) return status;

  // `--last-details` exits 1 when the run it describes failed, so only its output counts.
  const details = spawnSync("vp", ["run", "--last-details"], { encoding: "utf8" });
  const result = classifyOutcomes(parseLastDetails(details.stdout));

  if (result.kind === "passed") {
    console.log(
      `\nverify: failed (exit ${status}), and \`vp run --last-details\` names no failed task`,
    );

    return status;
  }

  console.log(["", ...failureReport(result, output)].join("\n"));

  return status;
}

if (import.meta.main) process.exitCode = await main();
