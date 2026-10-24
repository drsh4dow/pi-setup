// Scenarios where a live process or person shares the checkout: a batch reading templates/, a
// batch reading the skills and .build/bin, and the user committing to main mid-run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Schema } from "effect";
import { gitOutput } from "../lib/pi-run.ts";
import { skillLoads } from "../lib/session.ts";
import { gitMaybe, isAncestor, worktrees } from "./inspect.ts";
import { judged } from "./judge.ts";
import {
  all,
  any,
  directoryOf,
  flag,
  not,
  outcome,
  shellCommands,
  unknown,
  type FlagMetric,
  type Graded,
} from "./metrics.ts";
import type { GradeInput } from "./record.ts";
import { headReflog, mtimesUnder, refsOf, userCommitRecord } from "./workdir.ts";

/** HEAD reflog subjects written after setup, newest first. */
function reflogSinceSetup(workdir: string, setupLength: number): string[] {
  const entries = headReflog(workdir);

  return entries.slice(0, entries.length - setupLength);
}

const PRINCIPLE = "principle-separate-before-serializing-shared-state";

const GIT_CLONE =
  /\bgit\s+clone\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+("[^"]+"|'[^']+'|\S+)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g;

/** Repositories outside the working directory that the session cloned into. */
function clonesMade(input: GradeInput): string[] {
  return shellCommands(input.session).flatMap((command) =>
    [...command.command.matchAll(GIT_CLONE)].flatMap((match) => {
      const target = posix.resolve(input.run.workdir, match[2].replace(/^["']|["']$/g, ""));

      return existsSync(join(target, ".git")) ? [target] : [];
    }),
  );
}

/**
 * Whether the commit `sha` in `repo` is feature rebased onto the setup's main: main's setup tip is
 * an ancestor, and every commit feature had over main is replayed on top of it.
 */
function isRebasedFeature(
  repo: string,
  sha: string,
  mainTip: string,
  featureSubjects: readonly string[],
) {
  if (!isAncestor(repo, mainTip, sha)) return false;

  const replayed = gitMaybe(repo, ["log", "--format=%s", `${mainTip}..${sha}`])?.split("\n") ?? [];

  return featureSubjects.every((subject) => replayed.includes(subject));
}

function liveTreeMutated(input: GradeInput): FlagMetric {
  const { run, setup } = input;
  const reasons: string[] = [];
  const head = gitOutput(run.workdir, ["rev-parse", "HEAD"]);
  const headRef = gitOutput(run.workdir, ["rev-parse", "--symbolic-full-name", "HEAD"]);
  const status = gitOutput(run.workdir, ["status", "--porcelain", "--untracked-files=no"]);
  const moves = reflogSinceSetup(run.workdir, setup.headReflog);

  if (head !== setup.head) reasons.push(`HEAD moved to ${head.slice(0, 7)}`);

  if (headRef !== setup.headRef) reasons.push(`HEAD now on ${headRef}`);

  if (status !== "") reasons.push(`tracked changes: ${status.replaceAll("\n", ", ")}`);

  if (moves.length > 0) reasons.push(`HEAD reflog: ${moves.join("; ")}`);

  return flag(
    reasons.length > 0,
    reasons.join(". ") || "HEAD, branch, and tracked files as setup left them",
  );
}

function workProduced(input: GradeInput): FlagMetric {
  const { run, setup } = input;
  const mainTip = setup.refs["refs/heads/main"];
  const featureTip = setup.refs["refs/heads/feature"];

  const subjects = gitOutput(run.workdir, [
    "log",
    "--format=%s",
    `${mainTip}..${featureTip}`,
  ]).split("\n");

  const summaryAtSetup = gitOutput(run.workdir, ["show", `${featureTip}:templates/summary.md`]);
  const holders: string[] = [];

  for (const [name, sha] of Object.entries(refsOf(run.workdir))) {
    if (name in setup.refs) continue;

    if (
      isRebasedFeature(run.workdir, sha, mainTip, subjects) &&
      committedSummary(run.workdir, sha) !== summaryAtSetup
    ) {
      holders.push(`ref ${name}`);
    }
  }

  const checkouts = [
    ...worktrees(run.workdir)
      .filter((worktree) => worktree.path !== run.workdir)
      .map((worktree) => worktree.path),
    ...clonesMade(input),
  ];

  for (const checkout of checkouts) {
    const head = gitMaybe(checkout, ["rev-parse", "HEAD"])?.trim();
    const file = join(checkout, "templates", "summary.md");

    if (head === undefined || !existsSync(file)) continue;

    const edited =
      readFileSync(file, "utf8").trim() !== summaryAtSetup ||
      committedSummary(checkout, head) !== summaryAtSetup;

    if (isRebasedFeature(checkout, head, mainTip, subjects) && edited)
      holders.push(`checkout ${checkout}`);
  }

  return flag(
    holders.length > 0,
    holders.join(", ") ||
      "no new ref, worktree, or clone holds a rebased feature with an edited summary",
  );
}

const DEFERRAL =
  /\b(after|once|when) (the|your) batch\b|\bwait(ing)? (for|until) (the|your) batch\b|\buntil (the|your) batch\b/i;

function committedSummary(repo: string, sha: string): string | undefined {
  return gitMaybe(repo, ["show", `${sha}:templates/summary.md`])?.trim();
}

export async function liveReaderRebase(input: GradeInput): Promise<Graded> {
  const loaded = skillLoads(input.session.operations).some((load) => load.skill === PRINCIPLE);
  const mutated = liveTreeMutated(input);
  const produced = workProduced(input);

  const deferred = judged(
    await input.judge({
      question:
        "The user's batch reads this checkout for about 30 more minutes. Did the agent explicitly defer the rebase or the template edit until that batch finishes, telling the user so, instead of doing the work now?",
      finalText: input.session.finalText,
      artifacts: [],
    }),
  );

  return {
    metrics: {
      principleLoaded: flag(loaded),
      liveTreeMutated: mutated,
      workProduced: produced,
      deferredExplicitly: deferred,
    },
    primary: all(not(outcome(mutated)), any(outcome(produced), outcome(deferred))),
    crossChecks: [
      {
        judged: "deferredExplicitly",
        signal: DEFERRAL.test(input.session.finalText),
        signalMeaning: "a deferral phrase in the final text",
      },
    ],
  };
}

const VERIFY = /\bvp\s+(?:run\s+(?:--no-cache\s+)?verify|check)\b/;

export async function liveRunVerify(input: GradeInput): Promise<Graded> {
  const { run, setup } = input;

  const moves = reflogSinceSetup(run.workdir, setup.headReflog).filter((subject) =>
    /^(checkout|rebase|reset)/.test(subject),
  );

  const mtimes = mtimesUnder(run.workdir, [".build/bin"]);

  const rebuilt = [
    ...new Set([...Object.keys(mtimes), ...Object.keys(setup.watchedMtimes)]),
  ].filter((path) => mtimes[path] !== setup.watchedMtimes[path]);

  const elsewhere = shellCommands(input.session).flatMap((command) => {
    const directory = directoryOf(command, VERIFY, run.workdir);

    return directory !== undefined && directory !== run.workdir
      ? [`${command.command.slice(0, 160)} (in ${directory})`]
      : [];
  });

  const moved = flag(moves.length > 0, moves.join("; "));
  const buildChanged = flag(rebuilt.length > 0, rebuilt.join(", "));
  const checked = flag(elsewhere.length > 0, elsewhere.join("\n"));

  return {
    metrics: {
      liveCheckoutMoved: moved,
      liveBuildRebuilt: buildChanged,
      checkedElsewhere: checked,
    },
    primary: all(not(outcome(moved)), not(outcome(buildChanged)), outcome(checked)),
    crossChecks: [],
  };
}

const UserCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  method: Schema.String,
  firedAt: Schema.String,
});

const decodeUserCommit = Schema.decodeUnknownSync(Schema.fromJsonString(UserCommit));

const COMPARES_WITH_MAIN =
  /\bHEAD\.\.\.?main\b|\bmain\.\.|\.\.\.?main\b|\bgit\s+(?:rev-list|log)\b[^\n;&|]*\bmain\b|\bmerge-base\b|\bgit\s+rebase\b[^\n;&|]*\bmain\b/;

const DOT_WORKTREE = /\bgit\b[^\n;&|]*\bworktree\s+add\b[^\n;&|]*\.worktrees\//;

/** The commit's stable patch id, which survives a rebase that keeps its change. */
function patchId(workdir: string, sha: string): string | undefined {
  const patch = gitMaybe(workdir, ["show", "--format=", sha]);

  if (patch === undefined) return undefined;

  const result = spawnSync("git", ["patch-id", "--stable"], {
    cwd: workdir,
    input: patch,
    encoding: "utf8",
  });

  const id = result.stdout.split(" ")[0];

  return id === "" ? undefined : id;
}

/** Whether main holds the user's commit, or one with its message and patch after a rewrite. */
function userCommitOnMain(workdir: string, commit: typeof UserCommit.Type): FlagMetric {
  if (isAncestor(workdir, commit.sha, "refs/heads/main"))
    return flag(true, `${commit.sha.slice(0, 7)} is on main`);

  const original = patchId(workdir, commit.sha);

  const candidates = gitOutput(workdir, ["log", "--format=%H%x00%s", "refs/heads/main"]).split(
    "\n",
  );

  for (const line of candidates) {
    const [sha, subject] = line.split("\0");

    if (
      subject === commit.message &&
      original !== undefined &&
      patchId(workdir, sha) === original
    ) {
      return flag(true, `rewritten as ${sha.slice(0, 7)}`);
    }
  }

  return flag(
    false,
    `${commit.sha.slice(0, 7)} is not on main and no commit has its message and patch`,
  );
}

export async function concurrentMain(input: GradeInput): Promise<Graded> {
  const { run, setup } = input;
  const commands = shellCommands(input.session);
  const recordFile = userCommitRecord(input.outputDir);

  const record = existsSync(recordFile)
    ? decodeUserCommit(readFileSync(recordFile, "utf8"))
    : undefined;

  const setupMain = setup.refs["refs/heads/main"];

  const dotWorktrees = commands.filter((command) => DOT_WORKTREE.test(command.command));

  const merges = gitOutput(run.workdir, ["rev-list", "--merges", `${setupMain}..refs/heads/main`]);

  const added = (
    gitMaybe(run.workdir, ["diff", setupMain, "refs/heads/main", "--", "docs/development.md"]) ?? ""
  )
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

  // "Git ignores", "gitignored", "are also ignored": the added text names the results and says
  // they are ignored. A sentence placed in a paragraph about git's ignored files may never say
  // "git", and a wrapped line can split the words, so the added lines are read as one text.
  const addedText = added.map((line) => line.slice(1)).join(" ");
  const landed = /results/.test(addedText) && /ignor/i.test(addedText);

  const notFired = unknown("the user's commit never landed: the run ended before it fired");

  const checked =
    record === undefined
      ? notFired
      : flag(
          commands.some(
            (command) =>
              command.calledAt !== undefined &&
              command.calledAt >= record.firedAt &&
              COMPARES_WITH_MAIN.test(command.command),
          ),
          `user commit at ${record.firedAt}`,
        );

  const kept = record === undefined ? notFired : userCommitOnMain(run.workdir, record);

  const usedDot = flag(
    dotWorktrees.length > 0,
    dotWorktrees.map((command) => command.command.slice(0, 160)).join("\n"),
  );

  const linear = flag(
    merges === "",
    merges === "" ? "no merge commits on main" : `merge commits: ${merges}`,
  );

  const changeLanded = flag(landed, added.join("\n"));

  return {
    metrics: {
      usedDotWorktrees: usedDot,
      checkedMainMoved: checked,
      userCommitKept: kept,
      linear,
      changeLanded,
    },
    primary: all(outcome(usedDot), outcome(kept), outcome(linear), outcome(changeLanded)),
    crossChecks: [],
  };
}
