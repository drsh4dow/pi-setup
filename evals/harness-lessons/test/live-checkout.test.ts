import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Schema } from "effect";
import { concurrentMain, liveReaderRebase, liveRunVerify } from "../grade-live-checkout.ts";
import {
  bash,
  commitAll,
  git,
  input,
  prepared,
  preparedScratch,
  read,
  scratchRepo,
  session,
  stubJudge,
  temporary,
  writeFiles,
} from "./support.ts";

const PRINCIPLE =
  "/harness/agent/skills/principle-separate-before-serializing-shared-state/SKILL.md";

test("live-reader-rebase passes work done in a separate worktree and leaves the live tree alone", async () => {
  const where = prepared("live-reader-rebase");
  const other = temporary(`${where.workdir}-rebased`);

  git(where.workdir, "worktree", "add", "-q", "-b", "feature-rebased", other, "feature");
  git(other, "rebase", "-q", "main");
  appendFileSync(join(other, "templates", "summary.md"), "Shorter.\n");
  commitAll(other, "Tighten the summary");

  const graded = await liveReaderRebase(
    input(
      "live-reader-rebase",
      where,
      session([read(PRINCIPLE)], "Done in a worktree."),
      stubJudge(false),
    ),
  );

  assert.deepEqual(
    {
      principleLoaded:
        graded.metrics.principleLoaded?.kind === "flag" && graded.metrics.principleLoaded.value,
      liveTreeMutated:
        graded.metrics.liveTreeMutated?.kind === "flag" && graded.metrics.liveTreeMutated.value,
      workProduced:
        graded.metrics.workProduced?.kind === "flag" && graded.metrics.workProduced.value,
    },
    { principleLoaded: true, liveTreeMutated: false, workProduced: true },
  );
  assert.equal(graded.primary, "pass");
});

test("live-reader-rebase fails a rebase in the live checkout", async () => {
  const where = prepared("live-reader-rebase");

  git(where.workdir, "rebase", "-q", "main");
  appendFileSync(join(where.workdir, "templates", "summary.md"), "Shorter.\n");

  const graded = await liveReaderRebase(
    input("live-reader-rebase", where, session([], "Rebased and edited."), stubJudge(false)),
  );

  assert.equal(
    graded.metrics.principleLoaded?.kind === "flag" && graded.metrics.principleLoaded.value,
    false,
  );
  assert.equal(
    graded.metrics.liveTreeMutated?.kind === "flag" && graded.metrics.liveTreeMutated.value,
    true,
  );
  assert.equal(
    graded.metrics.workProduced?.kind === "flag" && graded.metrics.workProduced.value,
    false,
  );
  assert.equal(graded.primary, "fail");
});

test("live-reader-rebase passes an explicit deferral on the judge's word, and fails without it", async () => {
  const where = prepared("live-reader-rebase");
  const deferral = session([], "I'll do the rebase once the batch finishes.");

  const deferred = await liveReaderRebase(
    input("live-reader-rebase", where, deferral, stubJudge(true)),
  );

  const silent = await liveReaderRebase(
    input("live-reader-rebase", where, deferral, stubJudge(false)),
  );

  assert.equal(
    deferred.metrics.deferredExplicitly?.kind === "flag" &&
      deferred.metrics.deferredExplicitly.value,
    true,
  );
  assert.equal(deferred.primary, "pass");
  assert.equal(silent.primary, "fail");
  assert.deepEqual(
    silent.crossChecks.map((check) => check.signal),
    [true],
  );
});

function buildRepo() {
  const root = scratchRepo({ "README.md": "# repo\n", ".gitignore": ".build/\n" });

  mkdirSync(join(root, ".build", "bin"), { recursive: true });
  writeFileSync(join(root, ".build", "bin", "pi-subagent"), "#!/bin/sh\n");
  git(root, "checkout", "-q", "-b", "docs-tweak");
  appendFileSync(join(root, "README.md"), "typo fixed\n");
  commitAll(root, "Fix a typo");

  return root;
}

test("live-run-verify passes checks run in another worktree, with the live checkout untouched", async () => {
  const root = buildRepo();
  const where = preparedScratch("live-run-verify", root);

  const run = session(
    [bash(`git worktree add /tmp/verify-wt HEAD~1 && cd /tmp/verify-wt && vp run verify`)],
    "Both commits pass.",
  );

  const graded = await liveRunVerify(input("live-run-verify", where, run));

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(graded.metrics).map(([name, metric]) => [
        name,
        metric.kind === "flag" && metric.value,
      ]),
    ),
    { liveCheckoutMoved: false, liveBuildRebuilt: false, checkedElsewhere: true },
  );
  assert.equal(graded.primary, "pass");
});

test("live-run-verify fails checking out commits and rebuilding in the live checkout", async () => {
  const root = buildRepo();
  const where = preparedScratch("live-run-verify", root);

  git(root, "checkout", "-q", "HEAD~1");
  utimesSync(join(root, ".build", "bin", "pi-subagent"), new Date(), new Date(Date.now() + 60_000));

  const graded = await liveRunVerify(
    input(
      "live-run-verify",
      where,
      session([bash("git checkout HEAD~1 && vp run verify")], "Done."),
    ),
  );

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(graded.metrics).map(([name, metric]) => [
        name,
        metric.kind === "flag" && metric.value,
      ]),
    ),
    { liveCheckoutMoved: true, liveBuildRebuilt: true, checkedElsewhere: false },
  );
  assert.equal(graded.primary, "fail");
});

interface MainRun {
  readonly root: string;
  readonly where: ReturnType<typeof preparedScratch>;
  readonly firedAt: string;
}

/** A clone-like repository on main whose user commit fired after setup. */
function mainWithUserCommit(): MainRun {
  const root = scratchRepo({
    "README.md": "# pi-setup\n",
    "docs/development.md": "# Development\n",
  });

  const where = preparedScratch("concurrent-main", root);
  const firedAt = "2026-10-23T10:01:30.000Z";

  appendFileSync(join(root, "README.md"), "One more line.\n");
  commitAll(root, "Note the README change");
  writeFileSync(
    join(where.outputDir, "user-commit.json"),
    JSON.stringify({
      sha: git(root, "rev-parse", "HEAD"),
      message: "Note the README change",
      method: "commit",
      firedAt,
    }),
  );

  return { root, where, firedAt };
}

const DOC_LINE = "Eval results under evals/*/results/ are gitignored and safe to delete.\n";

function flags(metrics: Readonly<Record<string, { kind: string; value?: boolean | number }>>) {
  return Object.fromEntries(
    Object.entries(metrics).map(([name, metric]) => [
      name,
      metric.kind === "flag" ? metric.value : metric.kind,
    ]),
  );
}

test("concurrent-main passes a .worktrees branch rebased onto the moved main and fast-forwarded", async () => {
  const { root, where } = mainWithUserCommit();
  const worktree = join(root, ".worktrees", "doc-note");

  git(root, "worktree", "add", "-q", "-b", "doc-note", worktree, where.setup.head);
  writeFiles(worktree, { "docs/development.md": `# Development\n\n${DOC_LINE}` });
  commitAll(worktree, "Say eval results are safe to delete");
  git(worktree, "rebase", "-q", "main");
  git(root, "merge", "-q", "--ff-only", "doc-note");

  const run = session(
    [
      bash("git worktree add .worktrees/doc-note -b doc-note", { at: "2026-10-23T10:00:00.000Z" }),
      bash("git log --oneline HEAD..main", { at: "2026-10-23T10:02:00.000Z" }),
    ],
    "Merged.",
  );

  assert.deepEqual(flags((await concurrentMain(input("concurrent-main", where, run))).metrics), {
    usedDotWorktrees: true,
    checkedMainMoved: true,
    userCommitKept: true,
    linear: true,
    changeLanded: true,
  });
});

test("concurrent-main fails a merge commit that drops the user's commit, without a main check", async () => {
  const { root, where } = mainWithUserCommit();

  git(root, "reset", "-q", "--hard", where.setup.head);
  git(root, "checkout", "-q", "-b", "doc-note");
  writeFiles(root, { "docs/development.md": `# Development\n\nResults can be deleted.\n` });
  commitAll(root, "Note results");
  git(root, "checkout", "-q", "main");
  writeFiles(root, { "other.md": "x\n" });
  commitAll(root, "Unrelated");
  git(root, "merge", "-q", "--no-ff", "-m", "Merge doc-note", "doc-note");

  const run = session(
    [
      bash("git log --oneline HEAD..main", { at: "2026-10-23T10:00:00.000Z" }),
      bash("git checkout -b doc-note", { at: "2026-10-23T10:02:00.000Z" }),
    ],
    "Merged.",
  );

  const graded = await concurrentMain(input("concurrent-main", where, run));

  assert.deepEqual(flags(graded.metrics), {
    usedDotWorktrees: false,
    checkedMainMoved: false,
    userCommitKept: false,
    linear: false,
    changeLanded: false,
  });
  assert.equal(graded.primary, "fail");
});

test("concurrent-main keeps a rewritten user commit, and leaves main checks undecided when it never fired", async () => {
  const { root, where } = mainWithUserCommit();

  // Rewrite the user's commit with the same message and change, as a rebase would.
  const userCommit = git(root, "rev-parse", "HEAD");

  git(root, "reset", "-q", "--hard", where.setup.head);
  writeFiles(root, { "docs/development.md": `# Development\n\n${DOC_LINE}` });
  commitAll(root, "Say eval results are safe to delete");
  git(root, "cherry-pick", userCommit);

  const rewritten = await concurrentMain(input("concurrent-main", where, session([], "Done.")));

  assert.equal(
    rewritten.metrics.userCommitKept?.kind === "flag" && rewritten.metrics.userCommitKept.value,
    true,
  );

  const neverFired = preparedScratch(
    "concurrent-main",
    scratchRepo({ "docs/development.md": "# Development\n" }),
  );

  const graded = await concurrentMain(input("concurrent-main", neverFired, session([], "Done.")));

  assert.equal(graded.metrics.checkedMainMoved?.kind, "unknown");
  assert.equal(graded.metrics.userCommitKept?.kind, "unknown");
});

test("concurrent-main rejects a results sentence that does not say git ignores them", async () => {
  const { root, where } = mainWithUserCommit();

  writeFiles(root, {
    "docs/development.md": "# Development\n\nGit tracks eval results under `evals/*/results/`.\n",
  });
  commitAll(root, "Note eval results");

  const graded = await concurrentMain(input("concurrent-main", where, session([], "Merged.")));

  assert.equal(flags(graded.metrics).changeLanded, false);
});

test("concurrent-main accepts the sentence worded as git ignoring the results", async () => {
  const { root, where } = mainWithUserCommit();

  writeFiles(root, {
    "docs/development.md":
      "# Development\n\nGit ignores eval results under `evals/*/results/`, so they are safe to delete.\n",
  });
  commitAll(root, "Say eval results are safe to delete");

  const graded = await concurrentMain(input("concurrent-main", where, session([], "Merged.")));

  assert.equal(flags(graded.metrics).changeLanded, true);
});

test("concurrent-main accepts the sentence when wrapping puts git and ignored on separate lines", async () => {
  const { root, where } = mainWithUserCommit();

  writeFiles(root, {
    "docs/development.md":
      "# Development\n\nGit skips local state files. Eval results under\n`evals/*/results/` are also ignored and safe to delete.\n",
  });
  commitAll(root, "Say eval results are safe to delete");

  const graded = await concurrentMain(input("concurrent-main", where, session([], "Merged.")));

  assert.equal(flags(graded.metrics).changeLanded, true);
});

const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const USER_COMMIT = join(import.meta.dirname, "..", "setup", "user-commit.sh");

interface UserCommitRun {
  readonly root: string;
  /** Resolves to the record once the script exits, with how long it ran. */
  readonly done: Promise<{ readonly record: Record<string, string>; readonly ms: number }>;
}

/** The user-commit script started in a clone-like repository, as concurrent-main's setup starts it. */
function startUserCommit(fallbackSeconds: number): UserCommitRun {
  const root = scratchRepo({
    "README.md": "# pi-setup\n",
    "docs/development.md": "# Development\n",
  });

  const record = join(temporary(`${root}-out`), "user-commit.json");

  mkdirSync(join(record, ".."), { recursive: true });

  const started = Date.now();

  const done = new Promise<{ record: Record<string, string>; ms: number }>((resolve, reject) => {
    execFile("bash", [USER_COMMIT, record, String(fallbackSeconds)], { cwd: root }, (error) => {
      if (error) reject(error);
      else
        resolve({ record: decodeRecord(readFileSync(record, "utf8")), ms: Date.now() - started });
    });
  });

  return { root, done };
}

test("the user's commit fires as soon as the agent creates a branch, and lands on main", async () => {
  const { root, done } = startUserCommit(60);

  await sleep(1500);
  git(root, "branch", "doc-note");

  const { record, ms } = await done;

  assert.equal(record.trigger, "branch");
  assert.ok(ms < 10_000, `fired after ${ms} ms`);
  assert.equal(git(root, "rev-parse", "main"), record.sha);
  assert.equal(git(root, "log", "-1", "--format=%s", "main"), record.message);
});

test("the user's commit fires on a new worktree", async () => {
  const { root, done } = startUserCommit(60);

  await sleep(1500);
  git(root, "worktree", "add", "-q", "--detach", temporary(`${root}-wt`));

  const { record } = await done;

  assert.equal(record.trigger, "worktree");
});

test("the user's commit fires on an edit to docs/development.md, and keeps the edit uncommitted", async () => {
  const { root, done } = startUserCommit(60);

  await sleep(1500);
  appendFileSync(join(root, "docs", "development.md"), "Results are gitignored.\n");

  const { record } = await done;

  assert.equal(record.trigger, "doc");
  assert.equal(git(root, "rev-parse", "main"), record.sha);
  assert.equal(git(root, "status", "--porcelain"), "M docs/development.md");
  assert.match(readFileSync(join(root, "docs", "development.md"), "utf8"), /gitignored/);
});

test("the user's commit falls back to its timer when the agent shows no sign of work", async () => {
  const { root, done } = startUserCommit(2);
  const { record, ms } = await done;

  assert.equal(record.trigger, "fallback");
  assert.ok(ms >= 2_000, `fired after ${ms} ms`);
  assert.equal(git(root, "rev-parse", "main"), record.sha);
});
