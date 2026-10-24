#!/usr/bin/env node
// Runs each scenario against two harness checkouts, a baseline and a candidate, as organic Pi
// sessions, and keeps each session and its setup records for grade.ts. Reruns with the same
// --out skip finished runs, so an interrupted batch resumes. --dry-run prepares every planned
// working directory, checks its setup, and launches no model.
//
//   node evals/harness-lessons/run.ts --out <results-dir> --baseline <root> --candidate <root> \
//     [--arms baseline,candidate] [--only <scenario>,...] [--trials <n>] \
//     [--models anthropic/claude-opus-5-5] [--thinking high] [--concurrency 4] \
//     [--timeout-minutes <n>] [--dry-run]

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  candidateEnv,
  checkoutHarnessArgs,
  gitOutput,
  killProcessesIn,
  runPi,
  sessionFile,
  writeAtomically,
} from "../lib/pi-run.ts";
import { runPool } from "../lib/pool.ts";
import type { RunRecord } from "./record.ts";
import { scenarios, type Scenario } from "./scenarios.ts";
import { catchupStubEnv } from "./catchup-stubs.ts";
import { fakeGitHubEnv, fakeGitHubPaths } from "./fake-pr.ts";
import { dryRunChecks, setupChecks, type SetupCheck } from "./setup-checks.ts";
import { keepStateFolder, liveStateFolder } from "./state-folder.ts";
import { killProcessesWithEnv, prepareWorkdir, snapshot } from "./workdir.ts";

export interface Arm {
  readonly name: string;
  readonly root: string;
  readonly head: string;
}

interface PlannedRun {
  readonly scenario: Scenario;
  readonly arm: Arm;
  readonly model: string;
  readonly trial: number;
  readonly dir: string;
}

interface Settings {
  readonly thinking: string;
  /** Replaces every scenario's own timeout when set. */
  readonly timeoutMinutes: number | undefined;
}

const queues = new Map<string, Promise<void>>();

/** Runs tasks naming the same resource one after another. Tasks naming none start at once. */
export function exclusively<T>(resource: string | null, task: () => Promise<T>): Promise<T> {
  if (resource === null) return task();

  const previous = queues.get(resource) ?? Promise.resolve();
  const result = previous.then(task);

  queues.set(
    resource,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );

  return result;
}

/**
 * The arm's harness, plus a clone's own project skills: `--no-skills` also drops the clone's
 * `.agents/skills/`, which Pi would otherwise load from the working directory.
 */
export function harnessArgs({
  scenario,
  armRoot,
  workdir,
}: {
  scenario: Scenario;
  armRoot: string;
  workdir: string;
}): string[] {
  const args = checkoutHarnessArgs(armRoot);

  if (scenario.project.kind === "fixture") return args;

  return [...args, "--skill", join(workdir, ".agents", "skills")];
}

/** The seeded chat's file in the run's session directory, named as Pi names its sessions. */
export function seededSessionPath(sessionDir: string): string {
  return join(sessionDir, "2026-10-24T14-02-00-000Z_seeded-chat.jsonl");
}

function piArgs(
  run: PlannedRun,
  settings: Settings,
  sessionDir: string,
  workdir: string,
): string[] {
  return [
    "-p",
    "--model",
    run.model,
    "--thinking",
    settings.thinking,
    "--session-dir",
    sessionDir,
    ...(run.scenario.seededChat === null ? [] : ["--session", seededSessionPath(sessionDir)]),
    ...harnessArgs({ scenario: run.scenario, armRoot: run.arm.root, workdir }),
    run.scenario.prompt,
  ];
}

/** The command line as a reader wants it: the system prompt named by its file, not inlined. */
function displayCommand(run: PlannedRun, args: readonly string[]): string {
  const systemPrompt = readFileSync(join(run.arm.root, "agent", "SYSTEM.md"), "utf8");

  const shown = args.map((arg) => {
    if (arg === systemPrompt) return `<contents of ${join(run.arm.root, "agent", "SYSTEM.md")}>`;

    return /^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
  });

  return `pi ${shown.join(" ")}`;
}

function runEnv(run: PlannedRun, workdir: string): NodeJS.ProcessEnv {
  switch (run.scenario.fakeGitHub) {
    case null:
      return candidateEnv();
    case "babysit-pr-42":
      return { ...candidateEnv(), ...fakeGitHubEnv(run.dir) };
    case "catchup-prs":
      return { ...candidateEnv(), ...catchupStubEnv(run.dir, workdir) };
    default: {
      const exhaustive: never = run.scenario.fakeGitHub;

      return exhaustive;
    }
  }
}

const installed = new Set<string>();

/**
 * Installs the babysit watcher's dependencies in the arm once, before its first run, so no run
 * pays for the install or races another run's install into the same directory.
 */
function installBabysitWatcher(root: string) {
  if (installed.has(root)) return;

  execFileSync(join(root, "agent", "skills", "babysit", "scripts", "watch-pr"), ["--help"], {
    stdio: "ignore",
  });
  installed.add(root);
}

interface Prepared {
  /** Empty when setup threw before the working directory existed. */
  readonly workdir: string;
  readonly checks: readonly SetupCheck[];
}

function prepare(run: PlannedRun): Prepared {
  mkdirSync(run.dir, { recursive: true });

  let workdir: string;

  try {
    workdir = prepareWorkdir({ scenario: run.scenario, armRoot: run.arm.root, outputDir: run.dir });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { workdir: "", checks: [{ name: "setup ran", ok: false, detail }] };
  }

  const setup = snapshot(workdir, run.scenario);

  writeAtomically(join(run.dir, "setup.json"), `${JSON.stringify(setup, null, 2)}\n`);

  const checks = setupChecks({
    scenario: run.scenario,
    workdir,
    armRoot: run.arm.root,
    outputDir: run.dir,
    snapshot: setup,
  });

  return { workdir, checks };
}

function reap(run: PlannedRun, workdir: string) {
  if (workdir !== "") killProcessesIn(workdir);

  if (run.scenario.fakeGitHub === "babysit-pr-42")
    killProcessesWithEnv("FAKEGH_STATE", fakeGitHubPaths(run.dir).state);
}

/** Moves the state folder the run owns into its output directory, so the next run starts clean. */
function keepState(run: PlannedRun) {
  if (run.scenario.stateFolder !== null)
    keepStateFolder({ live: liveStateFolder(run.scenario.stateFolder), outputDir: run.dir });
}

async function execute(run: PlannedRun, settings: Settings): Promise<RunRecord> {
  if (run.scenario.fakeGitHub === "babysit-pr-42") installBabysitWatcher(run.arm.root);

  const { workdir, checks } = prepare(run);

  const problems = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${check.detail}`);

  const base = {
    scenario: run.scenario.id,
    arm: run.arm.name,
    armRoot: run.arm.root,
    armHead: run.arm.head,
    model: run.model,
    thinking: settings.thinking,
    trial: run.trial,
    workdir,
    setupProblems: problems,
  };

  if (problems.length > 0) {
    reap(run, workdir);

    return { ...base, exitCode: null, signal: null, timedOut: false, durationMs: 0, session: null };
  }

  const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-"));
  const timeoutMs = (settings.timeoutMinutes ?? run.scenario.timeoutMinutes) * 60_000;

  if (run.scenario.seededChat !== null)
    writeFileSync(seededSessionPath(sessionDir), run.scenario.seededChat(realpathSync(workdir)));

  const started = Date.now();

  const result = await runPi(
    workdir,
    piArgs(run, settings, sessionDir, workdir),
    run.dir,
    timeoutMs,
    runEnv(run, workdir),
  );

  reap(run, workdir);
  keepState(run);

  const session = sessionFile(sessionDir);

  if (session) copyFileSync(session, join(run.dir, "session.jsonl"));

  return { ...base, ...result, durationMs: Date.now() - started, session: session ?? null };
}

async function dryRun(run: PlannedRun, settings: Settings): Promise<boolean> {
  const { workdir, checks } = prepare(run);

  const slow =
    workdir === ""
      ? []
      : await dryRunChecks({
          scenario: run.scenario,
          workdir,
          armRoot: run.arm.root,
          outputDir: run.dir,
          snapshot: snapshot(workdir, run.scenario),
        });

  reap(run, workdir);

  const all = [...checks, ...slow];

  // A failed check may be a state folder this run did not write; it stays where it is.
  if (all.every((check) => check.ok)) keepState(run);
  const command = displayCommand(run, piArgs(run, settings, "<session-dir>", workdir));
  const timeout = settings.timeoutMinutes ?? run.scenario.timeoutMinutes;

  writeAtomically(
    join(run.dir, "dry-run.json"),
    `${JSON.stringify({ workdir, command, checks: all }, null, 2)}\n`,
  );

  const lines = [
    `== ${run.scenario.id} ${run.arm.name} ${run.model} t${run.trial}`,
    `   workdir: ${workdir}`,
    `   timeout: ${timeout} min`,
    `   command: ${command}`,
    ...all.map(
      (check) =>
        `   ${check.ok ? "ok  " : "FAIL"} ${check.name}${check.ok || check.detail === "" ? "" : `: ${check.detail}`}`,
    ),
  ];

  console.log(lines.join("\n"));

  return all.every((check) => check.ok);
}

/** The scenarios `--only` names, or without it the default set. */
export function selectScenarios(only: readonly string[] | undefined): Scenario[] {
  return scenarios.filter((scenario) => (only ? only.includes(scenario.id) : scenario.byDefault));
}

function list(value: string | undefined): string[] | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function usage(message: string): never {
  console.error(
    `${message}\nusage: node evals/harness-lessons/run.ts --out <results-dir> --baseline <root> --candidate <root> [options]`,
  );
  process.exit(2);
}

function arm(name: string, root: string | undefined): Arm {
  if (root === undefined) usage(`--${name} <root> is required for the ${name} arm`);

  const absolute = resolve(root);

  if (!existsSync(join(absolute, "agent", "SYSTEM.md")))
    usage(`${absolute} is not a harness checkout: no agent/SYSTEM.md`);

  return { name, root: absolute, head: gitOutput(absolute, ["rev-parse", "HEAD"]) };
}

function positive(name: string, raw: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1)
    usage(`--${name} must be a positive integer, got ${raw}`);

  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      baseline: { type: "string" },
      candidate: { type: "string" },
      arms: { type: "string", default: "baseline,candidate" },
      only: { type: "string" },
      trials: { type: "string" },
      models: { type: "string", default: "anthropic/claude-opus-5-5" },
      thinking: { type: "string", default: "high" },
      concurrency: { type: "string", default: "4" },
      "timeout-minutes": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (!values.out) usage("--out is required");

  const out = resolve(values.out);
  const only = list(values.only);
  const unknown = only?.filter((id) => !scenarios.some((scenario) => scenario.id === id)) ?? [];

  if (unknown.length > 0) usage(`unknown scenarios: ${unknown.join(", ")}`);

  const arms = (list(values.arms) ?? []).map((name) => {
    if (name === "baseline") return arm(name, values.baseline);

    if (name === "candidate") return arm(name, values.candidate);

    return usage(`unknown arm ${name}; the arms are baseline and candidate`);
  });

  const trials = values.trials === undefined ? undefined : positive("trials", values.trials);
  const timeout = values["timeout-minutes"];

  const settings: Settings = {
    thinking: values.thinking,
    timeoutMinutes: timeout === undefined ? undefined : positive("timeout-minutes", timeout),
  };

  const plan: PlannedRun[] = [];

  for (const scenario of selectScenarios(only)) {
    for (let trial = 1; trial <= (trials ?? scenario.trials); trial++) {
      for (const model of list(values.models) ?? []) {
        // Arms innermost, so both arms of a trial run close together in time.
        for (const runArm of arms) {
          const dir = join(out, scenario.id, runArm.name, model.replace("/", "_"), `t${trial}`);

          if (values["dry-run"] || !existsSync(join(dir, "run.json"))) {
            plan.push({ scenario, arm: runArm, model, trial, dir });
          }
        }
      }
    }
  }

  const concurrency = positive("concurrency", values.concurrency);

  if (values["dry-run"]) {
    console.log(
      `dry run: preparing ${plan.length} working directories in ${out}; no model is launched`,
    );

    let failed = 0;

    await runPool(plan, concurrency, async (run) => {
      const ok = await exclusively(run.scenario.stateFolder, () => dryRun(run, settings));

      if (!ok) failed += 1;
    });

    console.log(
      `\n${plan.length - failed}/${plan.length} working directories passed every setup check`,
    );
    process.exitCode = failed === 0 ? 0 : 1;

    return;
  }

  console.log(`${plan.length} runs to do in ${out}`);

  let finished = 0;

  await runPool(plan, concurrency, async (run) => {
    const record = await exclusively(run.scenario.stateFolder, () => execute(run, settings));

    writeAtomically(join(run.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
    finished += 1;

    const status =
      record.setupProblems.length > 0
        ? `setup failed: ${record.setupProblems.join("; ")}`
        : `exit ${record.exitCode ?? record.signal}${record.timedOut ? " (timed out)" : ""}`;

    console.log(
      `[${finished}/${plan.length}] ${record.scenario} ${record.arm} ${record.model} t${record.trial}: ${status}, ${Math.round(record.durationMs / 1000)}s`,
    );
  });
}

if (import.meta.main) await main();
