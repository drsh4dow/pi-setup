#!/usr/bin/env node
// Runs the implement-chunk prompt end to end on the tally fixture, once per arm and trial, with
// real subagents against the fake gh, tracker, and deploy. Each run's records land in
// <out>/<arm>/t<n>/; a rerun with the same --out skips runs that have a run.json, so a batch
// resumes. --dry-run prepares every planned world, checks its setup, and launches no model.
//
//   node evals/implement-chunk/run.ts --out <dir> --arms baseline=<root>,candidate=<root> \
//     [--trials 3] [--concurrency 2] [--timeout-minutes 180] [--max-turns 10] [--max-cost-usd 60] \
//     [--model anthropic/claude-opus-5-5] [--thinking high] [--dry-run]

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gitOutput, killProcessesIn, writeAtomically } from "../lib/pi-run.ts";
import { runPool } from "../lib/pool.ts";
import { killProcessesWithEnv } from "../harness-lessons/workdir.ts";
import { runAcceptance, type CheckOutcome } from "./acceptance.ts";
import { buildCommit, Deployer, serve, stopProcess, waitForVersion } from "./deploy.ts";
import { drive, type DriveRecord } from "./drive.ts";
import { branchOid } from "./gh-git.ts";
import { readSources, runIntegrity, type Sources } from "./integrity.ts";
import {
  armChecks,
  liveHarnessRoot,
  watcherCheck,
  worldChecks,
  writeChecks,
  type SetupCheck,
} from "./setup.ts";
import { PARENT_KEY } from "./tickets.ts";
import { freePort, prepareWorld, type World } from "./world.ts";

export interface Arm {
  readonly name: string;
  readonly root: string;
}

interface Settings {
  readonly model: string;
  readonly thinking: string;
  readonly timeoutMinutes: number;
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  readonly ciDelayMs: number;
  readonly botDelayMs: number;
}

interface PlannedRun {
  readonly arm: Arm;
  readonly trial: number;
  readonly dir: string;
}

export const PROMPT = `/implement-chunk ${PARENT_KEY}`;

function usage(message: string): never {
  console.error(
    `${message}\nusage: node evals/implement-chunk/run.ts --out <dir> --arms <name>=<root>[,<name>=<root>...] [options]`,
  );
  process.exit(2);
}

/** `baseline=/path,candidate=/path`, each root a harness checkout. */
export function parseArms(raw: string): Arm[] {
  return raw.split(",").map((item) => {
    const [name, root] = item.split("=");

    if (name === undefined || root === undefined || name === "" || root === "")
      usage(`--arms entry "${item}" is not <name>=<root>`);

    const absolute = resolve(root);

    if (!existsSync(join(absolute, "agent", "SYSTEM.md")))
      usage(`${absolute} is not a harness checkout: no agent/SYSTEM.md`);

    return { name, root: absolute };
  });
}

function armRecord(arm: Arm) {
  const status = gitOutput(arm.root, ["status", "--porcelain", "--", "agent"]);

  return {
    name: arm.name,
    root: arm.root,
    head: gitOutput(arm.root, ["rev-parse", "HEAD"]),
    dirtyAgentFiles: status.split("\n").filter((line) => line !== ""),
  };
}

const installed = new Set<string>();

/** Installs the arm's babysit watcher dependencies once, before its first run. */
function installWatcher(root: string) {
  if (installed.has(root)) return;

  execFileSync(join(root, "agent", "skills", "babysit", "scripts", "watch-pr"), ["--help"], {
    stdio: "ignore",
  });
  installed.add(root);
}

/** Copies the run's harness files into its records, so grading compares sessions against what ran. */
function snapshotHarness(world: World, dir: string) {
  const target = join(dir, "harness");
  const agent = world.home.agentDir;

  mkdirSync(join(target, "subagents"), { recursive: true });
  cpSync(join(agent, "SYSTEM.md"), join(target, "SYSTEM.md"));
  cpSync(join(agent, "skills", "subagents"), join(target, "subagents"), {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
  cpSync(join(agent, "prompts", "implement-chunk.md"), join(target, "implement-chunk.md"));
  // The live appendices as they were during the run, which the grader tells apart from the arm's.
  cpSync(join(homedir(), ".pi", "agent", "skills", "subagents"), join(target, "live-subagents"), {
    recursive: true,
    filter: (source) => !source.includes("node_modules"),
  });
}

async function acceptanceOnMain(
  world: World,
): Promise<{ commit: string | null; outcomes: CheckOutcome[] }> {
  const commit = branchOid(world.bare, "main");

  if (commit === null) return { commit, outcomes: [] };

  const build = buildCommit({ bare: world.bare, commit, dir: join(world.scratch, "acceptance") });

  if (!build.built)
    return {
      commit,
      outcomes: [{ ticket: "build", path: "npm run build", ok: false, got: build.output }],
    };

  const port = await freePort();

  const server = serve({
    tree: build.tree,
    port,
    logFile: join(world.scratch, "acceptance", "server.log"),
  });

  try {
    if (!(await waitForVersion(port, commit, 10_000)))
      return {
        commit,
        outcomes: [
          {
            ticket: "start",
            path: "node dist/server.mjs",
            ok: false,
            got: "the built server did not answer /version",
          },
        ],
      };

    return { commit, outcomes: await runAcceptance(`http://127.0.0.1:${port}`) };
  } finally {
    stopProcess(server);
  }
}

function reap(world: World) {
  killProcessesWithEnv("HOME", world.home.home);
  killProcessesIn(world.scratch);
}

// Children run in their own process groups, so a signal to the runner does not reach them.
const active = new Set<{ readonly world: World; readonly deployer: Deployer }>();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    for (const { world, deployer } of active) {
      deployer.stop();
      reap(world);
    }

    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

/** Moves everything a grader reads out of the scratch directory, then removes it. */
function archive(world: World, dir: string) {
  const sessions = join(dir, "sessions");
  const state = join(world.home.state, "pi-agent");

  cpSync(world.home.sessions, sessions, { recursive: true });

  if (existsSync(state)) cpSync(state, join(dir, "state"), { recursive: true });

  execFileSync(
    "git",
    ["--git-dir", world.bare, "bundle", "create", "-q", join(dir, "origin.bundle"), "--all"],
    { stdio: "ignore" },
  );
  writeAtomically(
    join(dir, "origin-log.txt"),
    gitOutput(world.workdir, ["log", "--graph", "--oneline", "--all", "--decorate"]),
  );

  const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: world.workdir,
    encoding: "utf8",
  });

  writeAtomically(join(dir, "worktrees.txt"), worktrees.stdout ?? "");
  rmSync(world.scratch, { recursive: true, force: true });
}

async function prepare(run: PlannedRun, settings: Settings) {
  const scratch = mkdtempSync(join(tmpdir(), "ic-eval-"));

  const suffix = scratch
    .slice(-6)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "x");

  const name = `tally-${run.arm.name}-t${run.trial}-${suffix}`;

  mkdirSync(run.dir, { recursive: true });

  const world = await prepareWorld({
    armRoot: run.arm.root,
    outDir: run.dir,
    scratch,
    name,
    delays: settings,
  });

  const deployer = new Deployer({
    bare: world.bare,
    port: world.deploy.port,
    dir: world.deploy.dir,
    log: world.deploy.log,
  });

  mkdirSync(world.deploy.dir, { recursive: true });
  await deployer.start();

  const deployed = readFileSync(world.deploy.log, "utf8").includes(`"serving":true`);

  const checks: SetupCheck[] = [
    ...armChecks(run.arm.root),
    ...worldChecks(world, run.arm.root),
    {
      name: "deploy serves main",
      ok: deployed,
      detail: deployed ? "" : readFileSync(world.deploy.log, "utf8").slice(-600),
    },
  ];

  return { world, deployer, checks };
}

async function execute(run: PlannedRun, settings: Settings) {
  installWatcher(run.arm.root);

  const { world, deployer, checks } = await prepare(run, settings);
  const handle = { world, deployer };

  const sources: Sources = {
    armRoot: run.arm.root,
    liveRoot: liveHarnessRoot(),
    agentDir: world.home.agentDir,
    armEntries: world.home.armEntries,
  };

  const before = readSources(sources);

  active.add(handle);

  const problems = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${check.detail}`);

  const base = {
    arm: { ...armRecord(run.arm), harnessDigest: before.copyDigest },
    trial: run.trial,
    name: world.name,
    agentDir: world.home.agentDir,
    port: world.deploy.port,
    model: settings.model,
    thinking: settings.thinking,
    prompt: PROMPT,
  };

  writeChecks(join(run.dir, "setup.json"), checks);
  snapshotHarness(world, run.dir);

  let driven: DriveRecord | null = null;
  let finalMain: Awaited<ReturnType<typeof acceptanceOnMain>> = { commit: null, outcomes: [] };
  let live: CheckOutcome[] = [];

  try {
    if (problems.length === 0) {
      driven = await drive(
        world,
        {
          model: settings.model,
          thinking: settings.thinking,
          prompt: PROMPT,
          timeoutMs: settings.timeoutMinutes * 60_000,
          maxTurns: settings.maxTurns,
          maxCostUsd: settings.maxCostUsd,
        },
        run.dir,
      );
      await deployer.tick();
      finalMain = await acceptanceOnMain(world);
      live = await runAcceptance(`http://127.0.0.1:${world.deploy.port}`);
    }
  } finally {
    deployer.stop();
    reap(world);
    active.delete(handle);
  }

  // Every process of the run is gone, so nothing changes the sources after this reading.
  const integrity = { armEntries: world.home.armEntries, before, after: readSources(sources) };

  writeAtomically(
    join(run.dir, "acceptance.json"),
    `${JSON.stringify({ finalMain, live }, null, 2)}\n`,
  );
  archive(world, run.dir);

  return {
    ...base,
    integrity,
    integrityProblems: runIntegrity({ runDir: run.dir, record: integrity, scratch: world.scratch })
      .problems,
    setupProblems: problems,
    stop: driven?.stop ?? null,
    wallMs: driven?.wallMs ?? 0,
  };
}

async function dryRun(run: PlannedRun, settings: Settings): Promise<boolean> {
  installWatcher(run.arm.root);

  const { world, deployer, checks } = await prepare(run, settings);
  const all = [...checks, watcherCheck(world, run.arm.root)];

  deployer.stop();
  reap(world);
  writeChecks(join(run.dir, "dry-run.json"), all);
  rmSync(world.scratch, { recursive: true, force: true });

  console.log(
    [
      `== ${run.arm.name} t${run.trial}: ${world.name}`,
      `   arm: ${run.arm.root} at ${armRecord(run.arm).head.slice(0, 7)}`,
      `   command: HOME=<run home> pi -p --model ${settings.model} --thinking ${settings.thinking} --session-dir <run>/root-session '${PROMPT}'`,
      `   caps: ${settings.timeoutMinutes} min, ${settings.maxTurns} user turns, $${settings.maxCostUsd}`,
      ...all.map(
        (check) =>
          `   ${check.ok ? "ok  " : "FAIL"} ${check.name}${check.ok ? "" : `: ${check.detail}`}`,
      ),
    ].join("\n"),
  );

  return all.every((check) => check.ok);
}

function positive(name: string, raw: string): number {
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0)
    usage(`--${name} must be a non-negative integer, got ${raw}`);

  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      arms: { type: "string" },
      trials: { type: "string", default: "3" },
      concurrency: { type: "string", default: "2" },
      "timeout-minutes": { type: "string", default: "180" },
      "max-turns": { type: "string", default: "10" },
      "max-cost-usd": { type: "string", default: "60" },
      model: { type: "string", default: "anthropic/claude-opus-5-5" },
      thinking: { type: "string", default: "high" },
      "ci-delay-seconds": { type: "string", default: "20" },
      "bot-delay-seconds": { type: "string", default: "45" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (values.out === undefined) usage("--out is required");

  if (values.arms === undefined) usage("--arms is required");

  const out = resolve(values.out);
  const arms = parseArms(values.arms);

  const settings: Settings = {
    model: values.model,
    thinking: values.thinking,
    timeoutMinutes: positive("timeout-minutes", values["timeout-minutes"]),
    maxTurns: positive("max-turns", values["max-turns"]),
    maxCostUsd: positive("max-cost-usd", values["max-cost-usd"]),
    ciDelayMs: positive("ci-delay-seconds", values["ci-delay-seconds"]) * 1000,
    botDelayMs: positive("bot-delay-seconds", values["bot-delay-seconds"]) * 1000,
  };

  const plan: PlannedRun[] = [];

  for (let trial = 1; trial <= positive("trials", values.trials); trial += 1) {
    // Arms innermost, so both arms of a trial run close together in time.
    for (const arm of arms) {
      const dir = join(out, arm.name, `t${trial}`);

      if (values["dry-run"] || !existsSync(join(dir, "run.json"))) plan.push({ arm, trial, dir });
    }
  }

  const concurrency = Math.max(1, positive("concurrency", values.concurrency));

  if (values["dry-run"]) {
    console.log(`dry run: preparing ${plan.length} worlds in ${out}; no model is launched`);

    let failed = 0;

    await runPool(plan, concurrency, async (run) => {
      if (!(await dryRun(run, settings))) failed += 1;
    });

    console.log(`\n${plan.length - failed}/${plan.length} worlds passed every setup check`);
    process.exitCode = failed === 0 ? 0 : 1;

    return;
  }

  console.log(`${plan.length} runs to do in ${out}`);

  await runPool(plan, concurrency, async (run) => {
    const started = Date.now();
    const record = await execute(run, settings);

    writeAtomically(join(run.dir, "run.json"), `${JSON.stringify(record, null, 2)}\n`);

    const status =
      record.setupProblems.length > 0
        ? `setup failed: ${record.setupProblems.join("; ")}`
        : `stopped: ${record.stop ?? "?"}`;

    const integrity =
      record.integrityProblems.length > 0
        ? `; INVALID: ${record.integrityProblems.join("; ")}`
        : "; arm and live harness untouched";

    console.log(
      `${run.arm.name} t${run.trial}: ${status}, ${Math.round((Date.now() - started) / 60_000)} min${integrity}`,
    );
  });
}

if (import.meta.main) await main();
