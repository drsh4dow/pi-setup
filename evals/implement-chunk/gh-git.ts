// The git side of the fake GitHub: the run's local bare repository is `origin`, so pull request
// heads, merges, and CI all read and write real refs there.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(bare: string, args: readonly string[]): string {
  return execFileSync("git", ["--git-dir", bare, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** The commit a branch points at, or null when the branch does not exist. */
export function branchOid(bare: string, branch: string): string | null {
  const result = spawnSync(
    "git",
    ["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`],
    {
      encoding: "utf8",
    },
  );

  return result.status === 0 ? result.stdout.trim() : null;
}

export function mergeBase(bare: string, a: string, b: string): string | null {
  const result = spawnSync("git", ["--git-dir", bare, "merge-base", a, b], { encoding: "utf8" });

  return result.status === 0 ? result.stdout.trim() : null;
}

/** The tree of merging `head` into `base`, or null when the merge conflicts. */
export function mergeTree(bare: string, base: string, head: string): string | null {
  const result = spawnSync("git", ["--git-dir", bare, "merge-tree", "--write-tree", base, head], {
    encoding: "utf8",
  });

  if (result.status === 0) return result.stdout.split("\n")[0].trim();

  if (result.status === 1) return null;

  throw new Error(`git merge-tree ${base} ${head} failed: ${result.stderr}`);
}

/** Creates a merge commit of `head` into `baseBranch` and moves the branch to it. */
export function mergeCommit({
  bare,
  baseBranch,
  head,
  message,
}: {
  bare: string;
  baseBranch: string;
  head: string;
  message: string;
}): string | null {
  const base = branchOid(bare, baseBranch);

  if (base === null) throw new Error(`base branch ${baseBranch} does not exist`);

  const tree = mergeTree(bare, base, head);

  if (tree === null) return null;

  const commit = execFileSync(
    "git",
    ["--git-dir", bare, "commit-tree", tree, "-p", base, "-p", head, "-F", "-"],
    {
      input: message,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Sam Rivera",
        GIT_AUTHOR_EMAIL: "sam@example.com",
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
      },
    },
  ).trim();

  git(bare, ["update-ref", `refs/heads/${baseBranch}`, commit, base]);

  return commit;
}

export function deleteBranch(bare: string, branch: string) {
  spawnSync("git", ["--git-dir", bare, "update-ref", "-d", `refs/heads/${branch}`]);
}

export function diff(bare: string, base: string, head: string, nameOnly: boolean): string {
  return git(bare, ["diff", ...(nameOnly ? ["--name-only"] : []), `${base}...${head}`]);
}

export interface CommitInfo {
  readonly oid: string;
  readonly headline: string;
}

/** The commits `head` has that `base` does not, oldest first. */
export function commitsBetween(bare: string, base: string, head: string): CommitInfo[] {
  const out = git(bare, ["log", "--reverse", "--format=%H%x09%s", `${base}..${head}`]);

  return out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [oid, ...headline] = line.split("\t");

      return { oid, headline: headline.join("\t") };
    });
}

export interface CheckResult {
  readonly passed: boolean;
  readonly output: string;
}

const OUTPUT_LIMIT = 4000;

/**
 * Runs the fixture's CI command, `npm run check`, at `oid` in a scratch worktree of the bare
 * repository, with BASE_REF at the merge base, as the workflow's `origin/<base_ref>` resolves.
 */
export function runCheck({
  bare,
  oid,
  baseOid,
}: {
  bare: string;
  oid: string;
  baseOid: string;
}): CheckResult {
  const scratch = mkdtempSync(join(tmpdir(), "fakegh-ci-"));
  const worktree = join(scratch, "checkout");

  try {
    git(bare, ["worktree", "add", "--detach", worktree, oid]);

    const base = mergeBase(bare, baseOid, oid) ?? baseOid;

    const result = spawnSync("npm", ["run", "--silent", "check"], {
      cwd: worktree,
      encoding: "utf8",
      timeout: 120_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", BASE_REF: base },
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    return { passed: result.status === 0, output: output.slice(-OUTPUT_LIMIT) };
  } finally {
    spawnSync("git", ["--git-dir", bare, "worktree", "remove", "--force", worktree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}
