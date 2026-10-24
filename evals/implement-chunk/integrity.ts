// Run integrity: a run counts only if it left the arm and the live harness as it found them. Two
// readings, both made after every run and again by the grader:
//
// - the sources, compared before and after: the arm's HEAD, git status, branches, and harness
//   files; the live `~/.pi/agent` status and the live repository's branches; and the run's own
//   copy of the harness, which a run that edits its prompt changes;
// - the sessions: every edit, write, redirect, or git write a root or child made outside the
//   run's scratch directory, or into the run's copy of the harness or a link into the real home.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import { argument, parseSession } from "../lib/session.ts";
import { ARM_ENTRIES, harnessDigest, LIVE_LINKED_FILES } from "./home.ts";
import { sessionFiles } from "./isolation.ts";
import { commandWrites } from "./rule-breaks.ts";
import { readSessionFacts } from "./sessions.ts";

export const SourceState = Schema.Struct({
  at: Schema.String,
  armHead: Schema.String,
  armStatus: Schema.Array(Schema.String),
  /** `harnessDigest` of the arm's own agent dir over the entries the run copied. */
  armDigest: Schema.String,
  /** Local branches of the arm's repository, which a worktree shares with its main checkout. */
  armBranches: Schema.Array(Schema.String),
  /** `git status -- agent` of the live checkout. */
  liveAgentStatus: Schema.Array(Schema.String),
  liveBranches: Schema.Array(Schema.String),
  /** `harnessDigest` of the run's copy. */
  copyDigest: Schema.String,
});

export type SourceState = typeof SourceState.Type;

export const IntegrityRecord = Schema.Struct({
  armEntries: Schema.Array(Schema.String),
  before: SourceState,
  after: Schema.NullOr(SourceState),
});

export type IntegrityRecord = typeof IntegrityRecord.Type;

export interface Integrity {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export interface Sources {
  readonly armRoot: string;
  /** The live harness checkout, `~/.pi`. */
  readonly liveRoot: string;
  /** The run's `~/.pi/agent`. */
  readonly agentDir: string;
  readonly armEntries: readonly string[];
}

/** Reads the arm, the live checkout, and the run's copy as they are now. */
export function readSources(sources: Sources): SourceState {
  const branches = (cwd: string) =>
    lines(git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]));

  return {
    at: new Date().toISOString(),
    armHead: git(sources.armRoot, ["rev-parse", "HEAD"]),
    armStatus: lines(git(sources.armRoot, ["status", "--porcelain", "--untracked-files=all"])),
    armDigest: harnessDigest(join(sources.armRoot, "agent"), sources.armEntries),
    armBranches: branches(sources.armRoot),
    liveAgentStatus: lines(
      git(sources.liveRoot, ["status", "--porcelain", "--untracked-files=all", "--", "agent"]),
    ),
    liveBranches: branches(sources.liveRoot),
    copyDigest: harnessDigest(sources.agentDir, sources.armEntries),
  };
}

function changed(label: string, before: readonly string[], after: readonly string[]): string[] {
  const added = after.flatMap((line) => (before.includes(line) ? [] : [`+ ${line}`]));
  const removed = before.flatMap((line) => (after.includes(line) ? [] : [`- ${line}`]));
  const diff = [...added, ...removed];

  return diff.length === 0
    ? []
    : [`${label} changed during the run: ${diff.slice(0, 5).join(", ")}`];
}

/** What the run changed in the sources it must leave alone. */
export function sourceProblems(record: IntegrityRecord | null): string[] {
  if (record === null)
    return ["no integrity record: the run predates the check, so its sources were never compared"];

  const { before, after } = record;
  const problems: string[] = [];

  if (before.copyDigest !== before.armDigest)
    problems.push("the run's copy of the harness differed from the arm at the start");

  if (after === null) return [...problems, "no after-run reading of the sources"];

  if (after.armHead !== before.armHead)
    problems.push(
      `the arm's HEAD moved from ${before.armHead.slice(0, 7)} to ${after.armHead.slice(0, 7)}`,
    );

  problems.push(...changed("the arm's git status", before.armStatus, after.armStatus));

  if (after.armDigest !== before.armDigest)
    problems.push("the arm's harness files changed during the run");

  const known = new Set([...before.armBranches, ...before.liveBranches]);

  for (const branch of new Set([...after.armBranches, ...after.liveBranches])) {
    if (!known.has(branch)) problems.push(`branch ${branch} was added to the arm's repository`);
  }

  problems.push(
    ...changed("the live ~/.pi/agent status", before.liveAgentStatus, after.liveAgentStatus),
  );

  if (after.copyDigest !== before.copyDigest)
    problems.push("the run changed its copy of the arm's harness");

  return problems;
}

export interface WriteScope {
  /** The run's scratch directory, `/tmp/ic-eval-*`, which holds its repository and home. */
  readonly scratch: string;
  readonly armEntries: readonly string[];
}

/**
 * Whether a write to `path`, issued from `cwd`, stays inside what the run owns: its scratch
 * directory, minus the run home's copy of the harness and its links into the real home and the
 * live checkout; or `/tmp` outside every other run's scratch directory, since `mktemp` lands there.
 */
export function ownedPath(path: string, cwd: string, scope: WriteScope): boolean {
  // Codemode cuts long arguments with `...`; a cut path that can still be the run's own is.
  const home = join(scope.scratch, "home");

  if (path.endsWith("...")) {
    const kept = path.slice(0, -3);
    const roots = [scope.scratch, join(home, ".local", "state"), join(home, ".pi", "agent")];

    if (roots.some((root) => root.startsWith(kept)) || ownedPath(kept, cwd, scope)) return true;
  }

  const expanded = path.replace(/^(?:~|\/HOME|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const under = (root: string) => absolute === root || absolute.startsWith(`${root}/`);

  if (absolute.startsWith("/dev/")) return true;

  if (under(home)) {
    const agentDir = join(home, ".pi", "agent");

    if ([...scope.armEntries, ...LIVE_LINKED_FILES].some((entry) => under(join(agentDir, entry))))
      return false;

    // Everything else in the run home links into the real home or the live checkout.
    return under(join(home, ".local", "state")) || under(agentDir);
  }

  if (under(scope.scratch)) return true;

  return absolute.startsWith("/tmp/") && !absolute.startsWith("/tmp/ic-eval-");
}

/** Every write one session made outside what the run owns, as `<tool>: <what>`. */
export function foreignWrites(jsonl: string, cwd: string, scope: WriteScope): string[] {
  const found: string[] = [];

  for (const operation of parseSession(withoutEmptyDetails(jsonl)).operations) {
    const at = operation.nested ? `codemode ${operation.tool}` : operation.tool;

    if (operation.tool === "edit" || operation.tool === "write") {
      const path = argument(operation, "path") ?? "";

      if (!ownedPath(path, cwd, scope)) found.push(`${at}: writes ${path}`);

      continue;
    }

    if (operation.tool !== "bash" && operation.tool !== "bg_start") continue;

    const writes = commandWrites(argument(operation, "command") ?? "");

    for (const { kind, target } of writes.files) {
      if (!ownedPath(target, cwd, scope)) found.push(`${at}: ${kind} of ${target}`);
    }

    for (const { verb, dir } of writes.gitWrites) {
      if (dir !== null && !ownedPath(dir, cwd, scope)) found.push(`${at}: git ${verb} in ${dir}`);
    }
  }

  return found;
}

/**
 * The session text with each `"details":{}` of a tool result dropped: codemode records an empty
 * object when a script made no call, which `parseSession` rejects although it means the same as
 * no details.
 */
function withoutEmptyDetails(jsonl: string): string {
  return jsonl
    .split("\n")
    .map((line) =>
      line.includes('"details":{}') ? line.replace('"details":{}', '"details":null') : line,
    )
    .join("\n");
}

/** The writes outside the run that the root (`root.jsonl`) and every child session of a run dir made. */
export function runForeignWrites(runDir: string, scope: WriteScope): string[] {
  const files = [
    join(runDir, "root.jsonl"),
    ...(existsSync(join(runDir, "sessions")) ? sessionFiles(join(runDir, "sessions")) : []),
  ].filter((file) => existsSync(file));

  return files.flatMap((file) =>
    foreignWrites(readFileSync(file, "utf8"), readSessionFacts(file).cwd, scope).map(
      (write) => `${file.slice(runDir.length + 1)}: ${write}`,
    ),
  );
}

/** Both readings of one run. */
export function runIntegrity({
  runDir,
  record,
  scratch,
}: {
  runDir: string;
  record: IntegrityRecord | null;
  scratch: string;
}): Integrity {
  const armEntries = record?.armEntries ?? ARM_ENTRIES;
  const writes = runForeignWrites(runDir, { scratch, armEntries });

  const problems = [
    ...sourceProblems(record),
    ...writes.slice(0, 8).map((write) => `wrote outside the run: ${write}`),
    ...(writes.length > 8 ? [`and ${writes.length - 8} more writes outside the run`] : []),
  ];

  return { ok: problems.length === 0, problems };
}
