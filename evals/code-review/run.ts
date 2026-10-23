#!/usr/bin/env node
// Runs each review arm on each fixture's feature branch, from this checkout's skills, and keeps
// the final review for grade.ts. The ground truth in defects/ never enters the working directory.
// Reruns with the same --out skip finished runs.
//
//   node evals/code-review/run.ts --out <results-dir> \
//     [--arms plain,code-review] [--models anthropic/claude-opus-5-5] \
//     [--trials 1] [--only orders,...] [--concurrency 4] [--thinking high] [--timeout-minutes 45]

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checkoutHarnessArgs,
  fixtureRepository,
  git,
  runPi,
  sessionFile,
  writeAtomically,
} from "../lib/pi-run.ts";
import { runPool } from "../lib/pool.ts";
import type { ReviewRunRecord } from "./grade.ts";
import { ARMS, loadFixtures, prompt, type Arm, type Fixture } from "./scenarios.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const ROOT = resolve(HERE, "..", "..");

/** The base project on main, and the overlay committed on a feature branch. */
export function prepareWorkdir(fixture: Fixture): string {
  const workdir = fixtureRepository(join(HERE, "fixtures", fixture.name), fixture.name);
  const message = join(mkdtempSync(join(tmpdir(), "commit-message-")), "message.txt");

  writeFileSync(message, fixture.truth.commitMessage);
  git(workdir, ["checkout", "-qb", "feature"]);
  cpSync(join(HERE, "changes", fixture.name), workdir, { recursive: true });
  git(workdir, ["add", "-A"]);
  git(workdir, ["commit", "-q", "-F", message]);

  return workdir;
}

async function execute(
  fixture: Fixture,
  arm: Arm,
  model: string,
  trial: number,
  dir: string,
  thinking: string,
  timeoutMs: number,
): Promise<ReviewRunRecord> {
  mkdirSync(dir, { recursive: true });

  const workdir = prepareWorkdir(fixture);
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
      prompt(arm, fixture.truth.spec),
    ],
    dir,
    timeoutMs,
  );

  const session = sessionFile(sessionDir);

  if (session) copyFileSync(session, join(dir, "session.jsonl"));

  return {
    fixture: fixture.name,
    arm,
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

function isArm(value: string): value is Arm {
  return ARMS.some((arm) => arm === value);
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      arms: { type: "string", default: ARMS.join(",") },
      models: { type: "string", default: "anthropic/claude-opus-5-5" },
      trials: { type: "string", default: "1" },
      only: { type: "string" },
      concurrency: { type: "string", default: "4" },
      thinking: { type: "string", default: "high" },
      "timeout-minutes": { type: "string", default: "45" },
    },
  });

  if (!values.out) {
    console.error("usage: node evals/code-review/run.ts --out <results-dir> [options]");
    process.exit(2);
  }

  const arms = list(values.arms) ?? [];
  const unknown = arms.filter((arm) => !isArm(arm));

  if (unknown.length > 0) {
    console.error(`unknown arms: ${unknown.join(", ")}`);
    process.exit(2);
  }

  const out = resolve(values.out);
  const only = list(values.only);
  const timeoutMs = Number(values["timeout-minutes"]) * 60_000;

  const todo = loadFixtures(HERE)
    .filter((fixture) => !only || only.includes(fixture.name))
    .flatMap((fixture) =>
      arms.filter(isArm).flatMap((arm) =>
        (list(values.models) ?? []).flatMap((model) =>
          Array.from({ length: Number(values.trials) }, (_, index) => ({
            fixture,
            arm,
            model,
            trial: index + 1,
            dir: join(out, fixture.name, arm, model.replace("/", "_"), `t${index + 1}`),
          })),
        ),
      ),
    )
    .filter((run) => !existsSync(join(run.dir, "run.json")));

  console.log(`${todo.length} runs to do in ${out}`);

  await runPool(todo, Number(values.concurrency), async (run) => {
    const record = await execute(
      run.fixture,
      run.arm,
      run.model,
      run.trial,
      run.dir,
      values.thinking,
      timeoutMs,
    );

    writeAtomically(join(run.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    console.log(
      `${record.fixture} ${record.arm} ${record.model} t${record.trial}: exit ${record.exitCode}, ${Math.round(record.durationMs / 60_000)} min`,
    );
  });
}

if (import.meta.main) await main();
