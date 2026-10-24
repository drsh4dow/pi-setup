// Builders for grader tests: synthetic sessions, a stub judge that records its questions,
// scratch repositories, and fixture working directories prepared as a run would get them.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { killProcessesIn } from "../../lib/pi-run.ts";
import type { Session, ToolOperation } from "../../lib/session.ts";
import type { JudgeAnswer, JudgeRequest } from "../judge.ts";
import type { GradeInput } from "../record.ts";
import { scenarioById, type ScenarioId } from "../scenarios.ts";
import { prepareWorkdir, snapshot, type SetupSnapshot } from "../workdir.ts";

const scratchPaths: string[] = [];

process.on("exit", () => {
  for (const path of scratchPaths) rmSync(path, { recursive: true, force: true });
});

/** `path`, removed when the test process exits. */
export function temporary(path: string): string {
  scratchPaths.push(path);

  return path;
}

const scratchDir = (prefix: string) => temporary(mkdtempSync(join(tmpdir(), prefix)));

export interface CallOptions {
  readonly output?: string;
  readonly at?: string;
  readonly succeeded?: boolean;
  readonly nested?: boolean;
}

export type Call = Omit<ToolOperation, "step">;

/** The arguments the graders read from tool calls. */
export interface ToolArguments {
  readonly path?: string;
  readonly command?: string;
  readonly content?: string;
  readonly code?: string;
  readonly title?: string;
  readonly edits?: readonly { readonly oldText: string; readonly newText: string }[];
}

export function call(tool: string, args: ToolArguments, options: CallOptions = {}): Call {
  return {
    tool,
    argumentsJson: JSON.stringify(args),
    succeeded: options.succeeded ?? true,
    nested: options.nested ?? false,
    calledAt: options.at,
    output: options.output ?? "",
  };
}

export const bash = (command: string, options: CallOptions = {}) =>
  call("bash", { command }, options);

export const read = (path: string) => call("read", { path });

export const edit = (path: string, oldText = "a", newText = "b") =>
  call("edit", { path, edits: [{ oldText, newText }] });

export const write = (path: string, content: string) => call("write", { path, content });

/** A session that made `calls` in order and ended its turn on each of `reports`. */
export function session(calls: readonly Call[], ...reports: readonly string[]): Session {
  return {
    operations: calls.map((operation, step) => ({ step, ...operation })),
    lastStopReason: "stop",
    finalText: reports.at(-1) ?? "",
    turnEndTexts: reports,
  };
}

export interface StubJudge {
  readonly judge: (request: JudgeRequest) => Promise<JudgeAnswer>;
  readonly requests: JudgeRequest[];
}

/** A judge that gives `answer` to every question and keeps the questions it was asked. */
export function stubJudge(answer: boolean | "unavailable" = true): StubJudge {
  const requests: JudgeRequest[] = [];

  return {
    requests,
    judge: async (request) => {
      requests.push(request);

      return answer === "unavailable"
        ? { kind: "unavailable", reason: "stub judge is down" }
        : { kind: "answered", pass: answer, why: "stub" };
    },
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function writeFiles(root: string, files: Readonly<Record<string, string>>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** A repository on main with `files` committed, as Sam Rivera. */
export function scratchRepo(files: Readonly<Record<string, string>>): string {
  const root = scratchDir("grade-test-");

  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Sam Rivera");
  git(root, "config", "user.email", "sam@example.com");
  writeFiles(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "Initial commit");

  return root;
}

export function commitAll(root: string, message: string) {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
}

export interface Prepared {
  readonly workdir: string;
  readonly outputDir: string;
  readonly setup: SetupSnapshot;
}

/** A scenario's real working directory after setup, with setup's background processes reaped. */
export function prepared(id: ScenarioId): Prepared {
  const scenario = scenarioById(id);
  const outputDir = scratchDir("grade-out-");
  const workdir = temporary(prepareWorkdir({ scenario, armRoot: "/nonexistent", outputDir }));

  killProcessesIn(workdir);

  return { workdir, outputDir, setup: snapshot(workdir, scenario) };
}

/** The snapshot a scratch repository would have had after setup, for `id`. */
export function preparedScratch(id: ScenarioId, workdir: string): Prepared {
  return {
    workdir,
    outputDir: scratchDir("grade-out-"),
    setup: snapshot(workdir, scenarioById(id)),
  };
}

export function input(
  id: ScenarioId,
  where: Prepared,
  graded: Session,
  judge: StubJudge = stubJudge(),
): GradeInput {
  return {
    run: {
      scenario: id,
      arm: "candidate",
      armRoot: "/harness",
      armHead: "0000000",
      model: "anthropic/claude-opus-5-5",
      thinking: "high",
      trial: 1,
      workdir: where.workdir,
      setupProblems: [],
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1000,
      session: "session.jsonl",
    },
    setup: where.setup,
    session: graded,
    outputDir: where.outputDir,
    judge: judge.judge,
  };
}
