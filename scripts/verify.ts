// `node scripts/verify.ts <task> [vp run options]` runs that task's checks and, when one fails,
// ends with which task failed and what it printed. The task runner kills the tasks still
// running once one fails, and each of those exits 137, as a real failure can, so this reads
// the run's details and lists those kills apart from the failure.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";

export interface TaskOutcome {
  // The [n] the details print, which counts commands in the order they finished.
  readonly order: number;
  // The `<package>#<task>` label.
  readonly task: string;
  // The command as the run printed it when the command started, such as `$ node x.ts`.
  readonly command: string;
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

const DETAILS_LINE = /^\s*\[(\d+)\] (\S+?): (.*) (?:✓|✗ \(exit code: (\d+)\))$/u;

const LABELED_LINE = /^\[([^\]\s]+#[^\]\s]+)\] ?(.*)$/su;

// `vp run: 0/17 cache hit (0%), 3 failed.` and `vp run: 2/2 successful.` both end a run, and
// the number after the slash counts its commands.
const SUMMARY_LINE = /^vp run: \d+\/(\d+)\b/u;

export function parseLastDetails(details: string): TaskOutcome[] {
  const outcomes: TaskOutcome[] = [];

  for (const line of stripVTControlCharacters(details).split("\n")) {
    const match = DETAILS_LINE.exec(line.trimEnd());

    if (match === null) continue;

    const [, order, task, command, exitCode] = match;

    outcomes.push({
      order: Number(order),
      task,
      command,
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

// What the inner run printed: each task's lines, and the command count of its closing summary.
export interface RunOutput {
  readonly linesByTask: ReadonlyMap<string, readonly string[]>;
  readonly commandCount: number;
}

// Another `vp run` in this workspace that ends after this one replaces the details this script
// reads. Details belong to this run when they list as many commands as its summary counted, and
// each one is a command this run printed as it started, under the same task.
export function detailsMatchRun(outcomes: readonly TaskOutcome[], run: RunOutput): boolean {
  if (outcomes.length !== run.commandCount) return false;

  const unmatched = new Map([...run.linesByTask].map(([task, lines]) => [task, [...lines]]));

  return outcomes.every((outcome) => {
    const lines = unmatched.get(outcome.task) ?? [];

    const start = lines.findIndex(
      (line) => line === outcome.command || line.startsWith(`${outcome.command} `),
    );

    if (start === -1) return false;

    lines.splice(start, 1);

    return true;
  });
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

export type DetailsRead =
  | { readonly kind: "read"; readonly outcomes: NonEmpty<TaskOutcome> }
  | { readonly kind: "unreadable"; readonly reason: string; readonly printed: readonly string[] };

// `--last-details` exits with the exit code of the run it describes, and 1 when it has none, so
// only the commands it lists show that it read them.
export function detailsRead(
  read: Pick<SpawnSyncReturns<string>, "error" | "signal" | "status" | "stdout" | "stderr">,
): DetailsRead {
  const printed = `${read.stdout ?? ""}${read.stderr ?? ""}`.split("\n").filter(Boolean);

  if (read.error !== undefined) {
    return { kind: "unreadable", reason: `could not start: ${read.error.message}`, printed };
  }

  if (read.signal !== null) {
    return { kind: "unreadable", reason: `was killed by ${read.signal}`, printed };
  }

  const [first, ...rest] = parseLastDetails(read.stdout);

  if (first === undefined) {
    return { kind: "unreadable", reason: `exited ${read.status} and listed no command`, printed };
  }

  return { kind: "read", outcomes: [first, ...rest] };
}

// The lines that end a failed run with the given exit status.
export function verifyReport(status: number, read: DetailsRead, run: RunOutput): string[] {
  const unknown = `verify: failed (exit ${status}), but`;
  const readAbove = "Read the task output above.";

  if (read.kind === "unreadable") {
    return [
      `${unknown} \`vp run --last-details\` ${read.reason}, so it cannot name the failed task. ${readAbove}`,
      ...read.printed,
    ];
  }

  if (!detailsMatchRun(read.outcomes, run)) {
    return [
      `${unknown} the last run details list commands this run did not run, so another vp run in this workspace replaced them. ${readAbove}`,
    ];
  }

  const result = classifyOutcomes(read.outcomes);

  if (result.kind === "passed") {
    return [`${unknown} its run details list no failed command. ${readAbove}`];
  }

  return failureReport(result, run.linesByTask);
}

// The inner run's summary points at `vp run --last-details`, which the outer `vp run verify`
// overwrites with its own single task by the time anyone reads it.
const LAST_DETAILS_HINT = " (Run `vp run --last-details` for full details)";

// Writes each line to the sink with its task label stripped, and keeps each task's lines.
// Resolves to the command count of the summary the run printed on this stream, or null.
async function relay(
  input: Readable,
  sink: Writable,
  linesByTask: Map<string, string[]>,
): Promise<number | null> {
  let commandCount: number | null = null;
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const { task, text } = taskLine(line);

    if (task === null) {
      const summary = SUMMARY_LINE.exec(text);

      if (summary !== null) commandCount = Number(summary[1]);
      sink.write(`${text.replace(LAST_DETAILS_HINT, "")}\n`);
      continue;
    }

    sink.write(`${text}\n`);

    const printed = linesByTask.get(task);

    if (printed === undefined) linesByTask.set(task, [text]);
    else printed.push(text);
  }

  return commandCount;
}

export type InnerRun =
  | { readonly kind: "run"; readonly args: readonly string[] }
  | { readonly kind: "usage" };

// The task's command names the inner task. `vp run` appends the options given after the outer
// task, such as --no-cache. They belong to the inner run, because the inner run owns the cache.
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

  const linesByTask = new Map<string, string[]>();

  const [status, countOut, countErr] = await Promise.all([
    closed,
    relay(run.stdout, process.stdout, linesByTask),
    relay(run.stderr, process.stderr, linesByTask),
  ]);

  if (status === 0) return status;

  const commandCount = countOut ?? countErr;

  // A run that printed no summary ran no task, so the details would describe an older run.
  if (commandCount === null) return status;

  const read = detailsRead(spawnSync("vp", ["run", "--last-details"], { encoding: "utf8" }));

  console.log(["", ...verifyReport(status, read, { linesByTask, commandCount })].join("\n"));

  return status;
}

if (import.meta.main) process.exitCode = await main();
