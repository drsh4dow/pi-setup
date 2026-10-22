#!/usr/bin/env node
// Runs to-spec and to-tickets against faketrack, a tracker the repository reaches only through
// its committed "Other" issue tracker record, from this checkout's skills. faketrack logs every
// call and keeps its issues outside the working directory, for grade.ts.
//
//   node evals/tracker-records/run.ts --out <results-dir> \
//     [--models anthropic/claude-opus-5-5] [--trials 1] [--only to-spec,...] \
//     [--concurrency 4] [--thinking high] [--timeout-minutes 30]

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  candidateEnv,
  checkoutHarnessArgs,
  fixtureRepository,
  runPi,
  sessionFile,
  writeAtomically,
} from "../lib/pi-run.ts";
import { runPool } from "../lib/pool.ts";
import type { TrackerRunRecord } from "./grade.ts";
import { scenarios, type Scenario } from "./scenarios.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const ROOT = resolve(HERE, "..", "..");

function seedState(scenario: Scenario): string {
  const issues = scenario.seed.map((issue, index) => ({
    id: index + 1,
    title: issue.title,
    body: issue.body,
    labels: [],
    parent: null,
    blockedBy: [],
    comments: [],
    closed: false,
  }));

  return `${JSON.stringify({ issues }, null, 2)}\n`;
}

async function execute(
  scenario: Scenario,
  model: string,
  trial: number,
  dir: string,
  thinking: string,
  timeoutMs: number,
): Promise<TrackerRunRecord> {
  mkdirSync(dir, { recursive: true });

  const workdir = fixtureRepository(join(HERE, "fixtures", "giftshop"), "giftshop");
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-"));
  const state = join(dir, "faketrack-state.json");
  const log = join(dir, "faketrack-log.jsonl");

  writeFileSync(state, seedState(scenario));
  writeFileSync(log, "");

  const env = {
    ...candidateEnv(),
    PATH: `${join(HERE, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    FAKETRACK_STATE: state,
    FAKETRACK_LOG: log,
  };

  const started = Date.now();

  const result = await runPi(
    workdir,
    [
      "-p",
      "--model",
      model,
      "--thinking",
      thinking,
      "--session-dir",
      sessionDir,
      ...checkoutHarnessArgs(ROOT),
      scenario.prompt,
    ],
    dir,
    timeoutMs,
    env,
  );

  const session = sessionFile(sessionDir);

  if (session) copyFileSync(session, join(dir, "session.jsonl"));

  return {
    skill: scenario.skill,
    model,
    trial,
    workdir,
    ...result,
    durationMs: Date.now() - started,
    session: session ?? null,
  };
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
      models: { type: "string", default: "anthropic/claude-opus-5-5" },
      trials: { type: "string", default: "1" },
      only: { type: "string" },
      concurrency: { type: "string", default: "4" },
      thinking: { type: "string", default: "high" },
      "timeout-minutes": { type: "string", default: "30" },
    },
  });

  if (!values.out) {
    console.error("usage: node evals/tracker-records/run.ts --out <results-dir> [options]");
    process.exit(2);
  }

  const out = resolve(values.out);
  const only = list(values.only);
  const timeoutMs = Number(values["timeout-minutes"]) * 60_000;

  const todo = scenarios
    .filter((scenario) => !only || only.includes(scenario.skill))
    .flatMap((scenario) =>
      (list(values.models) ?? []).flatMap((model) =>
        Array.from({ length: Number(values.trials) }, (_, index) => ({
          scenario,
          model,
          trial: index + 1,
          dir: join(out, scenario.skill, model.replace("/", "_"), `t${index + 1}`),
        })),
      ),
    )
    .filter((run) => !existsSync(join(run.dir, "run.json")));

  console.log(`${todo.length} runs to do in ${out}`);

  await runPool(todo, Number(values.concurrency), async (run) => {
    const record = await execute(
      run.scenario,
      run.model,
      run.trial,
      run.dir,
      values.thinking,
      timeoutMs,
    );

    writeAtomically(join(run.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`${record.skill} ${record.model} t${record.trial}: exit ${record.exitCode}`);
  });
}

if (import.meta.main) await main();
