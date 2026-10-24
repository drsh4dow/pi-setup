#!/usr/bin/env node
// Runs each scenario under each arm: a worker in a fresh invoices repository, a simulated parent
// that answers and reviews, and at most one follow-up round on a review directive. Keeps every
// round's session and working directory for grade.ts. Reruns with the same --out skip finished
// runs. --dry-run prepares every cell, checks its setup, and launches no model.
//
//   node evals/worker-questions/run.ts --out <dir> [--only s1-survives,...] [--arms A,C,R,L,C+push]
//     [--trials 3] [--models anthropic/claude-opus-5-5] [--thinking medium] [--concurrency 4]
//     [--timeout-minutes <n>] [--harness <checkout>] [--latency-seconds 60]
//     [--parent-model anthropic/claude-haiku-5-5] [--parent-thinking medium]
//     [--ask-timeout-minutes 10] [--dry-run]

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gitOutput, killProcessesIn, runPi, sessionFile, writeAtomically } from "../lib/pi-run.ts";
import { runPool } from "../lib/pool.ts";
import { parseSession } from "../lib/session.ts";
import { ARMS, MAX_QUESTION_RESUMES } from "./arms.ts";
import { renderBrief } from "./briefs.ts";
import {
  displayCommand,
  followUpPrompt,
  lateOrders,
  pushEnv,
  workerArgs,
  type Launch,
  type PlannedRun,
  type Settings,
} from "./launch.ts";
import { parentOracle, piParent, type Oracle } from "./oracle.ts";
import { questionBlock, serveQuestions } from "./protocol.ts";
import type { RoundRecord, RunRecord } from "./record.ts";
import { ArmId } from "./scenario.ts";
import { scenarios } from "./scenarios.ts";
import { askParentRoundTrip, setupChecks, type SetupCheck } from "./setup-checks.ts";
import { watchTriggers, type Learned } from "./timeline.ts";
import { refreshAwsSession } from "./tools-state.ts";
import {
  prepareRun,
  runPaths,
  snapshotRound,
  workerEnv,
  type Prepared,
  type RunPaths,
} from "./workdir.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

interface RunContext {
  readonly run: PlannedRun;
  readonly settings: Settings;
  readonly paths: RunPaths;
  readonly prepared: Prepared;
  readonly oracle: Oracle;
  readonly startedAt: number;
  readonly rounds: RoundRecord[];
  readonly learned: Learned;
}

async function launchRound(context: RunContext, launch: Launch): Promise<RoundRecord> {
  const { run, settings, paths, prepared } = context;
  const index = context.rounds.length + 1;
  const logDir = join(run.dir, "sessions", `round-${index}`);

  mkdirSync(logDir, { recursive: true });

  const sessionDir = launch.resume === null ? mkdtempSync(join(tmpdir(), "wq-sessions-")) : "";

  const env = {
    ...workerEnv({ scenario: run.scenario, paths }),
    ...pushEnv(run, paths),
    WQ_ASK_TIMEOUT_MS: String(settings.askTimeoutMinutes * 60_000),
  };

  const timeoutMs = (settings.timeoutMinutes ?? run.scenario.timeoutMinutes) * 60_000;
  const startedAt = Date.now();

  const worker = runPi(
    prepared.workdir,
    workerArgs(run, settings, launch, sessionDir),
    logDir,
    timeoutMs,
    env,
  );

  const answering = run.arm.askParent
    ? serveQuestions({
        dir: paths.asks,
        answer: (asked) => context.oracle.answer(asked.question, "ask-parent"),
        until: worker,
      })
    : Promise.resolve();

  const result = await worker;

  await answering;
  killProcessesIn(prepared.workdir);
  snapshotRound({ paths, workdir: prepared.workdir, round: index });

  const sessionPath = launch.resume ?? sessionFile(sessionDir) ?? null;
  const sessionCopy = sessionPath === null ? null : join("sessions", `round-${index}.jsonl`);

  if (sessionPath !== null && sessionCopy !== null)
    copyFileSync(sessionPath, join(run.dir, sessionCopy));

  const finalText =
    sessionPath === null ? "" : parseSession(readFileSync(sessionPath, "utf8")).finalText;

  const round: RoundRecord = {
    index,
    trigger: launch.trigger,
    launch: launch.resume === null ? "fresh" : "resume",
    startedAt,
    endedAt: Date.now(),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    sessionPath,
    sessionCopy,
    finalText,
  };

  context.rounds.push(round);

  return round;
}

const crashed = (round: RoundRecord) => !round.timedOut && round.exitCode !== 0;

/** Answers each `QUESTION:` block the worker ends on and resumes it, up to the cap; returns the last round. */
async function answerQuestions(
  context: RunContext,
  round: RoundRecord,
  resumes: number,
): Promise<RoundRecord> {
  const question = questionBlock(round.finalText);

  if (
    resumes >= MAX_QUESTION_RESUMES ||
    crashed(round) ||
    question === undefined ||
    round.sessionPath === null
  ) {
    return round;
  }

  const answer = await context.oracle.answer(question, "question-block");

  const next = await launchRound(context, {
    prompt: `Your parent answers: ${answer}`,
    trigger: "question",
    resume: round.sessionPath,
  });

  return answerQuestions(context, next, resumes + 1);
}

async function converse(context: RunContext, brief: string): Promise<RunRecord["review"]> {
  const { run, oracle } = context;

  let round = await launchRound(context, {
    prompt: brief,
    trigger: "brief",
    resume: null,
  });

  if (run.arm.questionBlocks) round = await answerQuestions(context, round, 0);

  if (crashed(round)) return null;

  const review = await oracle.review(round.finalText);

  if (review.kind === "accept") return review;

  if (run.arm.followUp === "resume" && round.sessionPath !== null) {
    await launchRound(context, {
      prompt: `Your parent reviewed your report and sends this directive: ${review.text}`,
      trigger: "directive",
      resume: round.sessionPath,
    });
  } else {
    await launchRound(context, {
      prompt: followUpPrompt({
        brief: renderBrief(run.scenario.brief, run.arm.brief, lateOrders(run, context.learned)),
        directive: review.text,
        report: round.finalText,
      }),
      trigger: "directive",
      resume: null,
    });
  }

  return review;
}

interface Prepare {
  readonly prepared: Prepared | undefined;
  readonly checks: readonly SetupCheck[];
}

function prepare(run: PlannedRun, settings: Settings): Prepare {
  let prepared: Prepared;

  try {
    prepared = prepareRun({ scenario: run.scenario, arm: run.arm, outputDir: run.dir });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { prepared: undefined, checks: [{ name: "setup ran", ok: false, detail }] };
  }

  const paths = runPaths(run.dir);

  const checks = setupChecks({
    scenario: run.scenario,
    arm: run.arm,
    prepared,
    paths,
    harness: settings.harness,
  });

  return { prepared, checks };
}

async function execute(run: PlannedRun, settings: Settings): Promise<RunRecord> {
  const { prepared, checks } = prepare(run, settings);
  const problems = checks.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`);
  const paths = runPaths(run.dir);
  const startedAt = Date.now();

  const base = {
    scenario: run.scenario.id,
    arm: run.arm.id,
    model: run.model,
    thinking: settings.thinking,
    trial: run.trial,
    harness: settings.harness,
    harnessHead: settings.harnessHead,
    workdir: prepared?.workdir ?? "",
    baseSha: prepared?.baseSha ?? "",
    latencySeconds: settings.latencySeconds,
    setupProblems: problems,
    startedAt,
  };

  if (prepared === undefined || problems.length > 0)
    return { ...base, rounds: [], review: null, learned: [] };

  const brief = renderBrief(run.scenario.brief, run.arm.brief);

  writeAtomically(join(run.dir, "brief.md"), brief);

  const learned: Learned = new Map();

  const oracle = parentOracle({
    brief,
    knowledge: run.scenario.knowledge,
    model: piParent({
      model: settings.parentModel,
      thinking: settings.parentThinking,
      sessionRoot: paths.parentSessions,
    }),
    startedAt,
    latencyMs: settings.latencySeconds * 1000,
    logFile: paths.parentLog,
    onContact: () => refreshAwsSession(paths.awsState),
    learned: () => new Set(learned.keys()),
  });

  const rounds: RoundRecord[] = [];

  const conversation = converse(
    { run, settings, paths, prepared, oracle, startedAt, rounds, learned },
    brief,
  );

  await watchTriggers({
    scenario: run.scenario,
    workdir: prepared.workdir,
    baseSha: prepared.baseSha,
    startedAt,
    learned,
    onLearn: (index) => {
      const push = run.scenario.knowledge.learned[index].push;

      if (run.arm.push && push !== null) writeFileSync(paths.mailbox, push);
    },
    until: conversation,
  });

  const review = await conversation;

  killProcessesIn(prepared.workdir);

  if (prepared.origin !== null) killProcessesIn(prepared.origin);

  return {
    ...base,
    rounds,
    review,
    learned: [...learned].map(([fact, elapsedSeconds]) => ({ fact, elapsedSeconds })),
  };
}

async function dryRun(run: PlannedRun, settings: Settings): Promise<boolean> {
  const { prepared, checks } = prepare(run, settings);
  const all = [...checks];
  let command = "(setup failed)";

  if (prepared !== undefined) {
    const context = {
      scenario: run.scenario,
      arm: run.arm,
      prepared,
      paths: runPaths(run.dir),
      harness: settings.harness,
    };

    if (run.arm.askParent) {
      all.push(await askParentRoundTrip(context));
      mkdirSync(context.paths.asks, { recursive: true });
    }

    const brief = renderBrief(run.scenario.brief, run.arm.brief);
    const launch = { prompt: brief, trigger: "brief", resume: null, push: run.arm.push } as const;

    command = displayCommand(settings, workerArgs(run, settings, launch, "<session-dir>"));
    killProcessesIn(prepared.workdir);
  }

  writeAtomically(
    join(run.dir, "dry-run.json"),
    `${JSON.stringify({ workdir: prepared?.workdir ?? "", command, checks: all }, null, 2)}\n`,
  );

  console.log(
    [
      `== ${run.scenario.id} ${run.arm.id} ${run.model} t${run.trial}`,
      `   workdir: ${prepared?.workdir ?? ""}`,
      `   command: ${command.slice(0, 400)}${command.length > 400 ? " …" : ""}`,
      ...all.map(
        (item) =>
          `   ${item.ok ? "ok  " : "FAIL"} ${item.name}${item.ok || item.detail === "" ? "" : `: ${item.detail}`}`,
      ),
    ].join("\n"),
  );

  return all.every((item) => item.ok);
}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function usage(message: string): never {
  console.error(
    `${message}\nusage: node evals/worker-questions/run.ts --out <results-dir> [options]; see the README`,
  );
  process.exit(2);
}

function positive(name: string, raw: string): number {
  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0)
    usage(`--${name} must be a non-negative number, got ${raw}`);

  return value;
}

export function plan({
  out,
  only,
  arms,
  trials,
  models,
  includeFinished,
}: {
  out: string;
  only: readonly string[] | undefined;
  arms: readonly string[];
  trials: number | undefined;
  models: readonly string[];
  includeFinished: boolean;
}): PlannedRun[] {
  const planned: PlannedRun[] = [];

  for (const scenario of scenarios.filter(
    (candidate) => only === undefined || only.includes(candidate.id),
  )) {
    for (let trial = 1; trial <= (trials ?? scenario.trials); trial++) {
      for (const model of models) {
        // Arms innermost, so the arms of one trial run close together in time.
        for (const armId of scenario.arms.filter((candidate) => arms.includes(candidate))) {
          const dir = join(out, scenario.id, armId, model.replace("/", "_"), `t${trial}`);

          if (includeFinished || !existsSync(join(dir, "run.json")))
            planned.push({ scenario, arm: ARMS[armId], model, trial, dir });
        }
      }
    }
  }

  return planned;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      only: { type: "string" },
      arms: { type: "string", default: ArmId.literals.join(",") },
      trials: { type: "string" },
      models: { type: "string", default: "anthropic/claude-opus-5-5" },
      thinking: { type: "string", default: "medium" },
      concurrency: { type: "string", default: "4" },
      "timeout-minutes": { type: "string" },
      harness: { type: "string", default: resolve(HERE, "..", "..") },
      "latency-seconds": { type: "string", default: "60" },
      "parent-model": { type: "string", default: "anthropic/claude-haiku-5-5" },
      "parent-thinking": { type: "string", default: "medium" },
      "ask-timeout-minutes": { type: "string", default: "10" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.out) usage("--out is required");

  const only = list(values.only);

  const unknownScenarios =
    only?.filter((id) => !scenarios.some((scenario) => scenario.id === id)) ?? [];

  if (unknownScenarios.length > 0) usage(`unknown scenarios: ${unknownScenarios.join(", ")}`);

  const arms = list(values.arms) ?? [];
  const unknownArms = arms.filter((id) => !ArmId.literals.some((known) => known === id));

  if (unknownArms.length > 0)
    usage(`unknown arms: ${unknownArms.join(", ")}; the arms are ${ArmId.literals.join(", ")}`);

  const harness = resolve(values.harness);

  if (!existsSync(join(harness, "agent", "SYSTEM.md")))
    usage(`${harness} is not a harness checkout: no agent/SYSTEM.md`);

  const timeout = values["timeout-minutes"];

  const settings: Settings = {
    harness,
    harnessHead: gitOutput(harness, ["rev-parse", "HEAD"]),
    thinking: values.thinking,
    timeoutMinutes: timeout === undefined ? undefined : positive("timeout-minutes", timeout),
    latencySeconds: positive("latency-seconds", values["latency-seconds"]),
    parentModel: values["parent-model"],
    parentThinking: values["parent-thinking"],
    askTimeoutMinutes: positive("ask-timeout-minutes", values["ask-timeout-minutes"]),
  };

  const out = resolve(values.out);
  const dry = values["dry-run"];

  const planned = plan({
    out,
    only,
    arms,
    trials: values.trials === undefined ? undefined : positive("trials", values.trials),
    models: list(values.models) ?? [],
    includeFinished: dry,
  });

  const concurrency = positive("concurrency", values.concurrency);

  if (dry) {
    console.log(`dry run: preparing ${planned.length} cells in ${out}; no model is launched`);

    let failed = 0;

    await runPool(planned, concurrency, async (run) => {
      if (!(await dryRun(run, settings))) failed += 1;
    });

    console.log(`\n${planned.length - failed}/${planned.length} cells passed every setup check`);
    process.exitCode = failed === 0 ? 0 : 1;

    return;
  }

  console.log(`${planned.length} runs to do in ${out}`);

  let finished = 0;

  await runPool(planned, concurrency, async (run) => {
    const record = await execute(run, settings);

    writeAtomically(join(run.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    finished += 1;

    const status =
      record.setupProblems.length > 0
        ? `setup failed: ${record.setupProblems.join("; ")}`
        : `${record.rounds.length} rounds, review ${record.review?.kind ?? "none"}`;

    const seconds = Math.round(
      ((record.rounds.at(-1)?.endedAt ?? record.startedAt) - record.startedAt) / 1000,
    );

    console.log(
      `[${finished}/${planned.length}] ${record.scenario} ${record.arm} ${record.model} t${record.trial}: ${status}, ${seconds}s`,
    );
  });
}

if (import.meta.main) await main();
