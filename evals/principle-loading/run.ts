#!/usr/bin/env node
// Runs each scenario as an organic Pi session in a fresh copy of its fixture and keeps the session
// for grade.ts. Reruns with the same --out skip finished runs, so an interrupted batch resumes.
//
//   node evals/principle-loading/run.ts --out evals/principle-loading/results/<name> \
//     [--models anthropic/claude-opus-5-5,openai/gpt-6.1-sol] [--trials 3] [--only <target>,...] \
//     [--concurrency 6] [--thinking high] [--timeout-minutes 20]

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  fixtureRepository,
  gitOutput,
  projectChanges,
  runPi,
  sessionFile,
  writeAtomically,
} from "../lib/pi-run.ts";
import { runPool } from "../lib/pool.ts";
import type { RunRecord } from "./grade.ts";
import { fixturePorts, scenarios, type Scenario } from "./scenarios.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const portQueues = new Map<number, Promise<void>>();

/** Runs tasks that hold the same port one after another. Tasks without a port start at once. */
export function onPort<T>(port: number | undefined, task: () => Promise<T>): Promise<T> {
  if (port === undefined) return task();

  const previous = portQueues.get(port) ?? Promise.resolve();
  const result = previous.then(task);

  portQueues.set(
    port,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );

  return result;
}

interface PlannedRun {
  readonly scenario: Scenario;
  readonly model: string;
  readonly trial: number;
  readonly dir: string;
}

/** A fresh working directory named like the project, holding the fixture as its git history. */
export function prepareWorkdir(scenario: Scenario): string {
  const workdir = fixtureRepository(join(HERE, "fixtures", scenario.fixture), scenario.fixture);

  if (scenario.setup) {
    execFileSync("bash", [join(HERE, "setup", scenario.setup)], { cwd: workdir, stdio: "inherit" });
  }

  return workdir;
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
  let finished = 0;

  await runPool(plan, Number(values.concurrency), async (run) => {
    const record = await onPort(fixturePorts.get(run.scenario.fixture), () =>
      execute(run, values.thinking, timeoutMs),
    );

    finished += 1;
    console.log(
      `[${finished}/${plan.length}] ${record.target} ${record.model} t${record.trial}: exit ${record.exitCode ?? record.signal}${record.timedOut ? " (timed out)" : ""}, ${Math.round(record.durationMs / 1000)}s`,
    );
  });
}

if (import.meta.main) await main();
