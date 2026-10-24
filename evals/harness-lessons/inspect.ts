// Reads the end state of a run's working directory: git facts, the files the run produced, and
// the result of running the project's own scripts on a copy.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { gitOutput } from "../lib/pi-run.ts";
import type { SetupSnapshot } from "./workdir.ts";

/** A git command's output, or undefined when it fails, as `git show <rev>:<missing path>` does. */
export function gitMaybe(cwd: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  return result.status === 0 ? result.stdout : undefined;
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd }).status === 0
  );
}

export interface Worktree {
  readonly path: string;
  readonly head: string | undefined;
  readonly branch: string | undefined;
}

export function worktrees(workdir: string): Worktree[] {
  const listing = gitOutput(workdir, ["worktree", "list", "--porcelain"]);

  return listing
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const field = (name: string) =>
        block
          .split("\n")
          .find((line) => line.startsWith(`${name} `))
          ?.slice(name.length + 1);

      return { path: field("worktree") ?? "", head: field("HEAD"), branch: field("branch") };
    });
}

/** Where a produced file was found, and how to check whether a path beside it exists there. */
export interface ProducedFile {
  readonly location: string;
  readonly path: string;
  readonly content: string;
  /** Whether `path`, relative to the repository root of this location, exists there. */
  readonly exists: (path: string) => boolean;
}

function fromWorkingTree(root: string, label: string, path: string): ProducedFile | undefined {
  const absolute = join(root, path);

  if (!existsSync(absolute)) return undefined;

  return {
    location: label,
    path,
    content: readFileSync(absolute, "utf8"),
    exists: (relative) => existsSync(join(root, relative)),
  };
}

function fromCommit(
  workdir: string,
  label: string,
  sha: string,
  path: string,
): ProducedFile | undefined {
  const content = gitMaybe(workdir, ["show", `${sha}:${path}`]);

  if (content === undefined) return undefined;

  return {
    location: label,
    path,
    content,
    exists: (relative) => gitMaybe(workdir, ["cat-file", "-e", `${sha}:${relative}`]) !== undefined,
  };
}

function trackedPaths(workdir: string, sha: string): string[] {
  return (gitMaybe(workdir, ["ls-tree", "-r", "--name-only", sha]) ?? "")
    .split("\n")
    .filter((line) => line !== "");
}

function untrackedAndTracked(root: string): string[] {
  const listing = gitMaybe(root, ["ls-files", "--cached", "--others", "--exclude-standard"]) ?? "";

  return listing.split("\n").filter((line) => line !== "");
}

/**
 * The files matching `pattern` that the run created or changed, wherever it left them: the main
 * working tree first, then main, then each linked worktree, then every other branch the run
 * moved or created. Callers grade the first and report the rest.
 */
export function producedFiles(
  workdir: string,
  setup: SetupSnapshot,
  pattern: RegExp,
): ProducedFile[] {
  const found: ProducedFile[] = [];
  const setupContent = (path: string) => gitMaybe(workdir, ["show", `${setup.head}:${path}`]);

  const changed = (file: ProducedFile | undefined) =>
    file !== undefined && file.content !== setupContent(file.path);

  const keep = (file: ProducedFile | undefined) => {
    if (file !== undefined && changed(file)) found.push(file);
  };

  for (const path of untrackedAndTracked(workdir).filter((candidate) => pattern.test(candidate))) {
    keep(fromWorkingTree(workdir, "working tree", path));
  }

  const main = gitMaybe(workdir, ["rev-parse", "refs/heads/main"])?.trim();

  if (main !== undefined && main !== setup.refs["refs/heads/main"]) {
    for (const path of trackedPaths(workdir, main).filter((candidate) => pattern.test(candidate))) {
      keep(fromCommit(workdir, "main", main, path));
    }
  }

  for (const worktree of worktrees(workdir).filter((candidate) => candidate.path !== workdir)) {
    for (const path of untrackedAndTracked(worktree.path).filter((candidate) =>
      pattern.test(candidate),
    )) {
      keep(fromWorkingTree(worktree.path, `worktree ${worktree.path}`, path));
    }
  }

  const refs = gitOutput(workdir, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
  ]);

  for (const line of refs.split("\n").filter((entry) => entry !== "")) {
    const [name, sha] = line.split(" ");

    if (name === "refs/heads/main" || setup.refs[name] === sha) continue;

    for (const path of trackedPaths(workdir, sha).filter((candidate) => pattern.test(candidate))) {
      keep(fromCommit(workdir, name, sha, path));
    }
  }

  return found;
}

export interface ScriptResult {
  readonly exitCode: number | null;
  readonly output: string;
}

const SCRIPT_TIMEOUT_MS = 3 * 60_000;

/**
 * Runs `command` in a throwaway copy of the working directory after `prepare` changes the copy,
 * so grading never alters what the run left behind.
 */
export function runInCopy(
  workdir: string,
  command: readonly [string, ...string[]],
  prepare: (copy: string) => void = () => {},
): ScriptResult {
  const copy = mkdtempSync(join(tmpdir(), "grade-copy-"));

  try {
    cpSync(workdir, copy, { recursive: true, verbatimSymlinks: true });
    prepare(copy);

    const result = spawnSync(command[0], command.slice(1), {
      cwd: copy,
      encoding: "utf8",
      timeout: SCRIPT_TIMEOUT_MS,
      // Without NODE_TEST_CONTEXT, so a `node --test` here reports its own exit code even when
      // the grader itself runs under the test runner.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, GIT_TERMINAL_PROMPT: "0" },
    });

    return { exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** Runs git in `cwd`, for preparing a copy. */
export function gitIn(cwd: string, args: readonly string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** `path` resolved against the directory of `from`, both relative to a repository root. */
export function besides(from: string, path: string): string {
  return posix.normalize(posix.join(posix.dirname(from), path));
}
