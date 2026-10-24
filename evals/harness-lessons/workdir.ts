// Builds a scenario's working directory for one arm, runs its setup, and records the state the
// metrics compare the end of the run against.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { fixtureRepository, git, gitOutput } from "../lib/pi-run.ts";
import { preparePriorWatch } from "./fake-pr.ts";
import type { Scenario } from "./scenarios.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

/** This eval's own directory inside a pi-setup checkout, removed from clones so runs cannot see it. */
const EVAL_PATH = "evals/harness-lessons";

export const SetupSnapshot = Schema.Struct({
  /** HEAD's commit after setup. */
  head: Schema.String,
  /** The branch HEAD points at, or "HEAD" when it is detached. */
  headRef: Schema.String,
  refs: Schema.Record(Schema.String, Schema.String),
  /** Entries in HEAD's reflog after setup. */
  headReflog: Schema.Int,
  trackedFiles: Schema.Array(Schema.String),
  /** Modification time of each watched file, and of each file under a watched directory. */
  watchedMtimes: Schema.Record(Schema.String, Schema.Finite),
});

export type SetupSnapshot = typeof SetupSnapshot.Type;

export const decodeSetupSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(SetupSnapshot));

export function refsOf(workdir: string): Record<string, string> {
  const listing = gitOutput(workdir, ["for-each-ref", "--format=%(refname) %(objectname)"]);

  return Object.fromEntries(
    listing
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [name, sha] = line.split(" ");

        return [name, sha];
      }),
  );
}

/** HEAD's reflog subjects, newest first. */
export function headReflog(workdir: string): string[] {
  const log = gitOutput(workdir, ["log", "-g", "--format=%gs", "HEAD"]);

  return log === "" ? [] : log.split("\n");
}

/** The modification time of each path and of every file under it, keyed by relative path. */
export function mtimesUnder(workdir: string, paths: readonly string[]) {
  const entries = paths.flatMap((path) => {
    const absolute = join(workdir, path);

    if (!existsSync(absolute)) return [];

    const below = statSync(absolute).isDirectory()
      ? readdirSync(absolute, { recursive: true }).map((entry) => join(path, String(entry)))
      : [];

    return [path, ...below].map(
      (relative) => [relative, statSync(join(workdir, relative)).mtimeMs] as const,
    );
  });

  return Object.fromEntries(entries);
}

export function snapshot(workdir: string, scenario: Scenario): SetupSnapshot {
  return {
    head: gitOutput(workdir, ["rev-parse", "HEAD"]),
    headRef: gitOutput(workdir, ["rev-parse", "--symbolic-full-name", "HEAD"]),
    refs: refsOf(workdir),
    headReflog: headReflog(workdir).length,
    trackedFiles: gitOutput(workdir, ["ls-files"]).split("\n"),
    watchedMtimes: mtimesUnder(workdir, scenario.watchedPaths),
  };
}

/**
 * A fresh repository holding the tracked files of the harness checkout at `root`, at its HEAD, as
 * one commit on `main`. It carries no history, remote, or object of the source repository, so a
 * run cannot reach the other arm's commits (a clone keeps every object even after its branches
 * are deleted), and a push cannot reach the real repository.
 */
export function cloneHarness(root: string): string {
  const workdir = mkdtempSync(join(tmpdir(), "pi-setup-"));

  execFileSync("bash", ["-c", 'git -C "$1" archive HEAD | tar -x -C "$2"', "_", root, workdir]);

  if (existsSync(join(workdir, EVAL_PATH))) rmSync(join(workdir, EVAL_PATH), { recursive: true });

  git(workdir, ["init", "--quiet", "-b", "main"]);
  git(workdir, ["config", "user.name", "Sam Rivera"]);
  git(workdir, ["config", "user.email", "sam@example.com"]);
  git(workdir, ["add", "-A"]);
  git(workdir, ["commit", "--quiet", "-m", "Initial commit"]);

  return workdir;
}

export interface PrepareOptions {
  readonly scenario: Scenario;
  readonly armRoot: string;
  /** The run's result directory, outside the working directory: setup writes its records there. */
  readonly outputDir: string;
}

export function userCommitRecord(outputDir: string): string {
  return join(outputDir, "user-commit.json");
}

/**
 * The working directory for one run, after setup. Background processes setup starts keep their
 * working directory inside it, so killing the processes in it after the run reaps them.
 */
export function prepareWorkdir({ scenario, armRoot, outputDir }: PrepareOptions): string {
  const workdir =
    scenario.project.kind === "clone"
      ? cloneHarness(armRoot)
      : fixtureRepository(
          join(HERE, "fixtures", scenario.project.fixture),
          scenario.project.fixture,
        );

  if (scenario.setup !== null) {
    execFileSync("bash", [join(HERE, "setup", scenario.setup)], {
      cwd: workdir,
      env: { ...process.env, SETUP_OUTPUT: outputDir },
      stdio: ["ignore", "inherit", "inherit"],
    });
  }

  if (scenario.fakeGitHub) preparePriorWatch(workdir, armRoot, outputDir);

  return workdir;
}

export interface WorkdirProcess {
  readonly pid: number;
  readonly command: string;
}

/** Processes whose working directory is inside `directory`. */
export function processesIn(directory: string): WorkdirProcess[] {
  const found: WorkdirProcess[] = [];

  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);

    if (!Number.isInteger(pid) || pid === process.pid) continue;

    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);

      if (cwd !== directory && !cwd.startsWith(`${directory}/`)) continue;

      found.push({
        pid,
        command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
      });
    } catch {
      // The process exited, or belongs to another user and cannot be ours.
    }
  }

  return found;
}

/**
 * Kills every process whose environment holds `name=value`. The fake GitHub's state path is unique
 * to a run, so this reaps a watcher the run left polling from outside its working directory.
 */
export function killProcessesWithEnv(name: string, value: string): number[] {
  const needle = `${name}=${value}`;
  const killed: number[] = [];

  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);

    if (!Number.isInteger(pid) || pid === process.pid) continue;

    try {
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(needle)) continue;

      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // The process exited, or belongs to another user and cannot be ours.
    }
  }

  return killed;
}
