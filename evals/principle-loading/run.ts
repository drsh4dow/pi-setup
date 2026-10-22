#!/usr/bin/env node
// Runs each scenario as an organic Pi session in a fresh copy of its fixture and keeps the session
// for grade.ts. Reruns with the same --out skip finished runs, so an interrupted batch resumes.
//
//   node evals/principle-loading/run.ts --out evals/principle-loading/results/<name> \
//     [--models anthropic/claude-opus-5-5,openai/gpt-6.1-sol] [--trials 3] [--only <target>,...] \
//     [--concurrency 6] [--thinking high] [--timeout-minutes 20]

import { spawn, execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunRecord } from "./grade.ts";
import { scenarios, type Scenario } from "./scenarios.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const KILL_GRACE_MS = 10_000;

interface PlannedRun {
  readonly scenario: Scenario;
  readonly model: string;
  readonly trial: number;
  readonly dir: string;
}

/**
 * The candidate must not inherit this session's identity: PI_* would point it at the parent's
 * session and model, and HERDR_* would make it act as a pane of the parent's workspace.
 */
function candidateEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("PI_") && !name.startsWith("HERDR_"),
    ),
  );
}

function git(cwd: string, args: readonly string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Files left changed plus commits added on any ref since the setup state, so a run that only asked counts 0. */
export function projectChanges(workdir: string, setupHead: string): number {
  const changedFiles = gitOutput(workdir, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line !== "").length;

  const newCommits = Number(gitOutput(workdir, ["rev-list", "--count", "--all", `^${setupHead}`]));

  return changedFiles + newCommits;
}

/** A fresh working directory named like the project, holding the fixture as its git history. */
export function prepareWorkdir(scenario: Scenario): string {
  const workdir = mkdtempSync(join(tmpdir(), `${scenario.fixture}-`));

  cpSync(join(HERE, "fixtures", scenario.fixture), workdir, { recursive: true });
  git(workdir, ["init", "-q", "-b", "main"]);
  git(workdir, ["config", "user.name", "Sam Rivera"]);
  git(workdir, ["config", "user.email", "sam@example.com"]);
  git(workdir, ["add", "-A"]);
  git(workdir, ["commit", "-qm", "Initial commit"]);

  if (scenario.setup) {
    execFileSync("bash", [join(HERE, "setup", scenario.setup)], { cwd: workdir, stdio: "inherit" });
  }

  return workdir;
}

function sessionFile(sessionDir: string): string | undefined {
  const file = readdirSync(sessionDir, { recursive: true, withFileTypes: true }).find(
    (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
  );

  return file ? join(file.parentPath, file.name) : undefined;
}

function writeAtomically(path: string, text: string) {
  const temporary = `${path}.tmp`;

  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

function runPi(cwd: string, args: readonly string[], logDir: string, timeoutMs: number) {
  const stdout = openSync(join(logDir, "stdout.txt"), "w");
  const stderr = openSync(join(logDir, "stderr.txt"), "w");

  const child = spawn("pi", args, {
    cwd,
    env: candidateEnv(),
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });

  let timedOut = false;

  // The candidate may start its own children (subagents, servers); signal the whole group.
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // The group already exited.
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
  }, timeoutMs);

  return new Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>(
    (done) => {
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        closeSync(stdout);
        closeSync(stderr);
        killGroup("SIGKILL");
        done({ exitCode, signal, timedOut });
      });
    },
  );
}

async function execute(run: PlannedRun, thinking: string, timeoutMs: number): Promise<RunRecord> {
  mkdirSync(run.dir, { recursive: true });

  const workdir = prepareWorkdir(run.scenario);
  const setupHead = gitOutput(workdir, ["rev-parse", "HEAD"]);
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-"));
  const started = Date.now();

  const result = await runPi(
    workdir,
    [
      "-p",
      "--model",
      run.model,
      "--thinking",
      thinking,
      "--session-dir",
      sessionDir,
      run.scenario.prompt,
    ],
    run.dir,
    timeoutMs,
  );

  const session = sessionFile(sessionDir);

  if (session) copyFileSync(session, join(run.dir, "session.jsonl"));

  const record: RunRecord = {
    target: run.scenario.target,
    model: run.model,
    trial: run.trial,
    workdir,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    session: session ?? null,
    projectChanges: projectChanges(workdir, setupHead),
  };

  writeAtomically(join(run.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);

  return record;
}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      models: { type: "string", default: "anthropic/claude-opus-5-5,openai/gpt-6.1-sol" },
      trials: { type: "string", default: "3" },
      only: { type: "string" },
      concurrency: { type: "string", default: "6" },
      thinking: { type: "string", default: "high" },
      "timeout-minutes": { type: "string", default: "20" },
    },
  });

  if (!values.out) {
    console.error("usage: node evals/principle-loading/run.ts --out <results-dir> [options]");
    process.exit(2);
  }

  const out = resolve(values.out);
  const only = list(values.only);

  const unknown =
    only?.filter((target) => !scenarios.some((scenario) => scenario.target === target)) ?? [];

  if (unknown.length > 0) {
    console.error(`unknown scenarios: ${unknown.join(", ")}`);
    process.exit(2);
  }

  const chosen = scenarios.filter((scenario) => !only || only.includes(scenario.target));
  const trials = Number(values.trials);
  const plan: PlannedRun[] = [];

  for (const scenario of chosen) {
    for (const model of list(values.models) ?? []) {
      for (let trial = 1; trial <= trials; trial++) {
        const dir = join(out, scenario.target, model.replace("/", "_"), `t${trial}`);

        if (!existsSync(join(dir, "run.json"))) plan.push({ scenario, model, trial, dir });
      }
    }
  }

  console.log(`${plan.length} runs to do in ${out}`);

  const timeoutMs = Number(values["timeout-minutes"]) * 60_000;
  let next = 0;
  let finished = 0;

  const worker = async () => {
    while (next < plan.length) {
      const run = plan[next++];
      // Each worker runs its share of the plan one at a time; the pool bounds concurrency.
      // oxlint-disable-next-line no-await-in-loop
      const record = await execute(run, values.thinking, timeoutMs);

      finished += 1;
      console.log(
        `[${finished}/${plan.length}] ${record.target} ${record.model} t${record.trial}: exit ${record.exitCode ?? record.signal}${record.timedOut ? " (timed out)" : ""}, ${Math.round(record.durationMs / 1000)}s`,
      );
    }
  };

  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
}

if (import.meta.main) await main();
