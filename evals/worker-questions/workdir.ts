// One run's working directory and records: the invoices fixture with the scenario's plant as its
// first commit, a bare origin and fake GitHub state when the scenario has a pull request, the fake
// tools on PATH, and a copy of the working directory after each round for the graders.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { candidateEnv, fixtureRepository, git, gitOutput } from "../lib/pi-run.ts";
import { EVAL_BIN, type Arm } from "./arms.ts";
import type { Scenario } from "./scenario.ts";
import { initialAwsState, writeState } from "./tools-state.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

const FIXTURE = join(HERE, "fixtures", "invoices");

const PLANTS = join(HERE, "fixtures", "plants");

export function runPaths(outputDir: string) {
  return {
    bin: join(outputDir, "bin"),
    asks: join(outputDir, "asks"),
    ghState: join(outputDir, "gh-state.json"),
    ghLog: join(outputDir, "gh-log.jsonl"),
    awsState: join(outputDir, "aws-state.json"),
    awsLog: join(outputDir, "aws-log.jsonl"),
    pushLog: join(outputDir, "push-log.jsonl"),
    mailbox: join(outputDir, "mailbox.txt"),
    parentLog: join(outputDir, "parent-log.jsonl"),
    parentSessions: join(outputDir, "parent-sessions"),
    rounds: join(outputDir, "rounds"),
  };
}

export type RunPaths = ReturnType<typeof runPaths>;

export interface Prepared {
  readonly workdir: string;
  readonly baseSha: string;
  /** The bare repository `origin` points at, when the scenario has a pull request. */
  readonly origin: string | null;
}

/** Every file the plant adds or replaces, relative to the repository root. */
export function plantFiles(scenario: Scenario): string[] {
  if (scenario.plant === null) return [];

  const root = join(PLANTS, scenario.plant);

  return execFileSync("find", [".", "-type", "f"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^\.\//, ""))
    .toSorted();
}

export function prepareRun({
  scenario,
  arm,
  outputDir,
}: {
  scenario: Scenario;
  arm: Arm;
  outputDir: string;
}): Prepared {
  const paths = runPaths(outputDir);
  const staging = mkdtempSync(join(tmpdir(), "wq-staging-"));

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(paths.asks, { recursive: true });
  mkdirSync(paths.bin, { recursive: true });

  cpSync(FIXTURE, staging, { recursive: true });

  if (scenario.plant !== null) cpSync(join(PLANTS, scenario.plant), staging, { recursive: true });

  const workdir = fixtureRepository(staging, "invoices");

  rmSync(staging, { recursive: true, force: true });

  // The fakes shadow the real tools in every run, so no worker reaches a real account.
  for (const tool of ["gh", "aws", ...(arm.askParent ? ["ask-parent"] : [])]) {
    symlinkSync(join(EVAL_BIN, tool), join(paths.bin, tool));
  }

  let origin: string | null = null;

  if (scenario.github !== null) {
    origin = mkdtempSync(join(tmpdir(), "invoices-origin-"));
    git(origin, ["init", "-q", "--bare", "-b", "main"]);
    git(workdir, ["remote", "add", "origin", origin]);
    git(workdir, ["push", "-q", "-u", "origin", "main"]);
    writeState(paths.ghState, {
      repo: "acme/invoices",
      origin,
      settings: scenario.github,
      pullRequests: [],
      refusedMerges: [],
    });
  }

  if (scenario.awsCallsBeforeExpiry !== null)
    writeState(paths.awsState, initialAwsState(scenario.awsCallsBeforeExpiry));

  return { workdir, baseSha: gitOutput(workdir, ["rev-parse", "HEAD"]), origin };
}

/**
 * The worker's environment: no parent identity, no AWS credentials of the host, the fake tools
 * first on PATH, and the state files of the scenario's fakes.
 */
export function workerEnv({
  scenario,
  paths,
}: {
  scenario: Scenario;
  paths: RunPaths;
}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(candidateEnv()).filter(([name]) => !name.startsWith("AWS_")),
  );

  const worker: NodeJS.ProcessEnv = {
    ...env,
    PATH: `${paths.bin}${delimiter}${process.env.PATH ?? ""}`,
    GIT_TERMINAL_PROMPT: "0",
    WQ_ASK_DIR: paths.asks,
    WQ_GH_LOG: paths.ghLog,
    WQ_AWS_LOG: paths.awsLog,
  };

  if (scenario.github !== null) worker.WQ_GH_STATE = paths.ghState;

  if (scenario.awsCallsBeforeExpiry !== null) worker.WQ_AWS_STATE = paths.awsState;

  return worker;
}

export const roundDir = (paths: RunPaths, round: number) => join(paths.rounds, String(round));

/** Keeps the working directory and the fake GitHub as they stood when round `round` ended. */
export function snapshotRound({
  paths,
  workdir,
  round,
}: {
  paths: RunPaths;
  workdir: string;
  round: number;
}) {
  const dir = roundDir(paths, round);

  mkdirSync(dir, { recursive: true });
  cpSync(workdir, join(dir, "workdir"), { recursive: true, verbatimSymlinks: true });

  if (existsSync(paths.ghState)) cpSync(paths.ghState, join(dir, "gh-state.json"));
}
