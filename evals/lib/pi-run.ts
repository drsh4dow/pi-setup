// Runs one Pi session in a throwaway project and cleans up after it. Every eval under evals/ shares
// these steps: copy a fixture into a fresh git repository, run `pi -p` there with a clean
// identity, keep the session file, and kill whatever the candidate left running.

import { spawn, execFileSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KILL_GRACE_MS = 10_000;

/**
 * Pi arguments that load the system prompt, skills, and prompts of the checkout at `root` instead
 * of the live agent directory's, so an eval measures a branch before it is merged. Settings,
 * credentials, extensions, and MCP servers still come from the live agent directory.
 */
export function checkoutHarnessArgs(root: string): string[] {
  return [
    "--system-prompt",
    readFileSync(join(root, "agent", "SYSTEM.md"), "utf8"),
    "--no-skills",
    "--skill",
    join(root, "agent", "skills"),
    "--no-prompt-templates",
    "--prompt-template",
    join(root, "agent", "prompts"),
  ];
}

/**
 * The candidate must not inherit this session's identity: PI_* would point it at the parent's
 * session and model, and HERDR_* would make it act as a pane of the parent's workspace.
 */
export function candidateEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("PI_") && !name.startsWith("HERDR_"),
    ),
  );
}

export function git(cwd: string, args: readonly string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

export function gitOutput(cwd: string, args: readonly string[]): string {
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

/** A fresh working directory named like the fixture, holding the fixture as its first commit. */
export function fixtureRepository(fixtureDir: string, name: string): string {
  const workdir = mkdtempSync(join(tmpdir(), `${name}-`));

  cpSync(fixtureDir, workdir, { recursive: true });
  git(workdir, ["init", "-q", "-b", "main"]);
  git(workdir, ["config", "user.name", "Sam Rivera"]);
  git(workdir, ["config", "user.email", "sam@example.com"]);
  git(workdir, ["add", "-A"]);
  git(workdir, ["commit", "-qm", "Initial commit"]);

  return workdir;
}

export function sessionFile(sessionDir: string): string | undefined {
  const file = readdirSync(sessionDir, { recursive: true, withFileTypes: true }).find(
    (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
  );

  return file ? join(file.parentPath, file.name) : undefined;
}

export function writeAtomically(path: string, text: string) {
  const temporary = `${path}.tmp`;

  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/**
 * Kills every process working inside the directory. A server the candidate started in its own
 * process group (a background terminal, nohup) survives the group kill and would keep the
 * fixture's port for the next run.
 */
export function killProcessesIn(directory: string): number[] {
  const killed: number[] = [];

  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);

    if (!Number.isInteger(pid) || pid === process.pid) continue;

    let cwd: string;

    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // The process exited, or belongs to another user and cannot be ours.
      continue;
    }

    if (cwd !== directory && !cwd.startsWith(`${directory}/`)) continue;

    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // It exited between the read and the kill.
    }
  }

  return killed;
}

export interface PiResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

export function runPi(
  cwd: string,
  args: readonly string[],
  logDir: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = candidateEnv(),
): Promise<PiResult> {
  const stdout = openSync(join(logDir, "stdout.txt"), "w");
  const stderr = openSync(join(logDir, "stderr.txt"), "w");

  const child = spawn("pi", args, {
    cwd,
    env,
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

  return new Promise((done) => {
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      closeSync(stdout);
      closeSync(stderr);
      killGroup("SIGKILL");
      killProcessesIn(cwd);
      done({ exitCode, signal, timedOut });
    });
  });
}
