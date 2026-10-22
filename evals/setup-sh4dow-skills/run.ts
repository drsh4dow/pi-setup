#!/usr/bin/env node
// Runs setup-sh4dow-skills twice on each fixture, from this checkout's skills: once to write the
// config record and once more to show a rerun on an unchanged repository changes nothing.
// Reruns with the same --out skip finished runs.
//
//   node evals/setup-sh4dow-skills/run.ts --out <results-dir> \
//     [--models anthropic/claude-opus-5-5] [--trials 1] [--only storefront,...] \
//     [--concurrency 3] [--thinking high] [--timeout-minutes 30]

import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkoutHarnessArgs,
  fixtureRepository,
  git,
  gitOutput,
  projectChanges,
  runPi,
  sessionFile,
  writeAtomically,
} from "../lib/pi-run.ts";
import { runPool } from "../lib/pool.ts";
import type { PassRecord, SetupRunRecord } from "./grade.ts";
import { PROMPT, scenarios, type Scenario } from "./scenarios.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const ROOT = resolve(HERE, "..", "..");

export function prepareWorkdir(scenario: Scenario): string {
  const workdir = fixtureRepository(join(HERE, "fixtures", scenario.fixture), scenario.fixture);

  if (scenario.remote) git(workdir, ["remote", "add", "origin", scenario.remote]);

  return workdir;
}

async function pass(
  workdir: string,
  model: string,
  thinking: string,
  logDir: string,
  timeoutMs: number,
): Promise<PassRecord> {
  mkdirSync(logDir, { recursive: true });

  const before = gitOutput(workdir, ["rev-parse", "HEAD"]);
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-"));
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
      PROMPT,
    ],
    logDir,
    timeoutMs,
  );

  const session = sessionFile(sessionDir);

  if (session) copyFileSync(session, join(logDir, "session.jsonl"));

  return {
    ...result,
    durationMs: Date.now() - started,
    session: session ?? null,
    changes: projectChanges(workdir, before),
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
      concurrency: { type: "string", default: "3" },
      thinking: { type: "string", default: "high" },
      "timeout-minutes": { type: "string", default: "30" },
    },
  });

  if (!values.out) {
    console.error("usage: node evals/setup-sh4dow-skills/run.ts --out <results-dir> [options]");
    process.exit(2);
  }

  const out = resolve(values.out);
  const only = list(values.only);
  const chosen = scenarios.filter((scenario) => !only || only.includes(scenario.fixture));
  const timeoutMs = Number(values["timeout-minutes"]) * 60_000;

  const plan = chosen.flatMap((scenario) =>
    (list(values.models) ?? []).flatMap((model) =>
      Array.from({ length: Number(values.trials) }, (_, index) => ({
        scenario,
        model,
        trial: index + 1,
        dir: join(out, scenario.fixture, model.replace("/", "_"), `t${index + 1}`),
      })),
    ),
  );

  const todo = plan.filter((run) => !existsSync(join(run.dir, "run.json")));

  console.log(`${todo.length} runs to do in ${out}`);

  await runPool(todo, Number(values.concurrency), async (run) => {
    const workdir = prepareWorkdir(run.scenario);

    const first = await pass(
      workdir,
      run.model,
      values.thinking,
      join(run.dir, "first"),
      timeoutMs,
    );

    const second = await pass(
      workdir,
      run.model,
      values.thinking,
      join(run.dir, "second"),
      timeoutMs,
    );

    const record: SetupRunRecord = {
      fixture: run.scenario.fixture,
      model: run.model,
      trial: run.trial,
      workdir,
      first,
      second,
    };

    writeAtomically(join(run.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(
      `${record.fixture} ${record.model} t${record.trial}: first changed ${first.changes}, second changed ${second.changes}`,
    );
  });
}

if (import.meta.main) await main();
