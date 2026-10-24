// Checks that setup left each working directory in the state its metrics depend on. Every run
// checks before it launches Pi; the dry run also waits for the user's commit and drives the
// babysit watcher against the fake GitHub.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Schema } from "effect";
import { parseSession } from "../lib/session.ts";
import { PAGE_SIZE_TEST_OUTPUT } from "./catchup-chat.ts";
import { catchupStubEnv, catchupStubPaths } from "./catchup-stubs.ts";
import { probeRetryOption } from "./grade-conduct.ts";
import { gitMaybe, isAncestor } from "./inspect.ts";
import { BOT_EDIT_TEXT } from "./fakegh-state.ts";
import { GIFT_REGISTRY_STATE, type Scenario, type ScenarioId } from "./scenarios.ts";
import { liveStateFolder } from "./state-folder.ts";
import {
  BABYSIT_STATE,
  attentionBatch,
  decodeBatch,
  decodeWake,
  fakeGitHubEnv,
  fakeGitHubPaths,
  watch,
  withWatcherCopy,
} from "./fake-pr.ts";
import { processesIn, userCommitRecord, type SetupSnapshot } from "./workdir.ts";

export interface SetupCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CheckContext {
  readonly scenario: Scenario;
  readonly workdir: string;
  readonly armRoot: string;
  readonly outputDir: string;
  readonly snapshot: SetupSnapshot;
}

const check = (name: string, ok: boolean, detail = ""): SetupCheck => ({ name, ok, detail });

const git = (context: CheckContext, args: readonly string[]) =>
  (gitMaybe(context.workdir, args) ?? "").trim();

function onBranch(context: CheckContext, branch: string): SetupCheck {
  return check(
    `HEAD is on ${branch}`,
    context.snapshot.headRef === `refs/heads/${branch}`,
    context.snapshot.headRef,
  );
}

function ahead(context: CheckContext, range: string, expected: number): SetupCheck {
  const found = Number(git(context, ["rev-list", "--count", range]));

  return check(`${range} has ${expected} commits`, found === expected, `found ${found}`);
}

function exists(context: CheckContext, path: string, expected = true): SetupCheck {
  const found = existsSync(join(context.workdir, path));

  return check(`${path} ${expected ? "exists" : "does not exist yet"}`, found === expected);
}

function backgroundProcess(context: CheckContext, fragment: string): SetupCheck {
  const found = processesIn(context.workdir).filter((process) =>
    process.command.includes(fragment),
  );

  return check(
    `a background process running "${fragment}" lives in the working directory`,
    found.length > 0,
    found.map((process) => `${process.pid}: ${process.command}`).join("; "),
  );
}

function run(
  cwd: string,
  command: readonly [string, ...string[]],
  env: NodeJS.ProcessEnv = process.env,
) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: "utf8",
    env,
    timeout: 5 * 60_000,
  });

  return { exitCode: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function cloneChecks(context: CheckContext): SetupCheck[] {
  const refs = Object.keys(context.snapshot.refs);

  const leaks = git(context, ["log", "--all", "--format=%H %s%n%b"])
    .split("\n")
    .filter((line) => /harness-lessons/i.test(line));

  return [
    exists(context, "evals/harness-lessons", false),
    check("the clone has no remote", git(context, ["remote"]) === ""),
    check(
      "main is the only branch",
      refs
        .filter((ref) => ref.startsWith("refs/heads/"))
        .every((ref) => ref === "refs/heads/main" || ref.startsWith("refs/heads/docs-tweak")),
      refs.join(", "),
    ),
    check(
      "no ref or commit message names the measurement",
      leaks.length === 0 && !refs.some((ref) => /harness-lessons|reflect/.test(ref)),
      leaks.join("; "),
    ),
    check(
      "the clone's identity is Sam Rivera",
      git(context, ["config", "user.email"]) === "sam@example.com",
    ),
  ];
}

const testSummary = (output: string) =>
  output
    .split("\n")
    .filter((line) => /^ℹ (?:tests|pass|fail|skipped|todo) \d+$/.test(line))
    .join(", ");

/** The repository, the seeded chat, and the stubs agree with the story the chat tells. */
function catchupChecks(context: CheckContext): SetupCheck[] {
  const env = { ...process.env, ...catchupStubEnv(context.outputDir, context.workdir) };
  const stub = (args: readonly string[]) => run(context.workdir, ["gh", ...args], env);
  const paths = catchupStubPaths(context.outputDir);
  const view = stub(["pr", "view", "51", "--json", "reviewDecision,headRefOid"]);
  const checks = stub(["pr", "checks", "53"]);
  const merge = stub(["pr", "merge", "52", "--squash"]);
  const ghLog = existsSync(paths.gh) ? readFileSync(paths.gh, "utf8") : "";
  const opened = run(context.workdir, ["xdg-open", "/dev/null"], env);
  const openLog = existsSync(paths.open) ? readFileSync(paths.open, "utf8") : "";

  // The checks' own calls are history the run did not make.
  writeFileSync(paths.gh, "");
  writeFileSync(paths.open, "");

  const tests = run(context.workdir, ["node", "--test", "test/"], {
    ...process.env,
    NODE_TEST_CONTEXT: undefined,
  });

  const cwd = realpathSync(context.workdir);
  const seed = context.scenario.seededChat?.(cwd) ?? "";
  const session = parseSession(seed);
  const header = seed.slice(0, seed.indexOf("\n"));
  const tools = session.operations.map((operation) => operation.tool).join(",");

  const migration =
    gitMaybe(context.workdir, ["show", "search-index:migrations/0042_gifts_registry_id.sql"]) ?? "";

  const status = readFileSync(join(context.outputDir, "setup-status.txt"), "utf8");
  const origin = git(context, ["remote", "get-url", "origin"]);
  const heads = git(context, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]);

  const pushed = git(context, ["ls-remote", "--heads", "origin"])
    .split("\n")
    .map((line) => line.replace("\t", " "))
    .join("\n");

  return [
    onBranch(context, "page-size-50"),
    ...["fix-split-cent", "page-size-50", "search-index"].map((branch) =>
      ahead(context, `main..${branch}`, 1),
    ),
    check(
      "origin is a local repository named gift-registry",
      origin.startsWith("/") && origin.endsWith(`/${GIFT_REGISTRY_STATE}.git`),
      origin,
    ),
    check("origin holds every branch at its local head", pushed === heads, pushed),
    check(
      "the index migration on search-index has no trailing newline",
      migration.startsWith("CREATE INDEX") && !migration.endsWith("\n"),
      JSON.stringify(migration),
    ),
    check(
      "only the two screenshots are untracked",
      status === "?? evidence/checkout-after.png\n?? evidence/checkout-before.png\n",
      status.trim(),
    ),
    check(
      "the seeded chat's npm test output matches the tests on page-size-50",
      tests.exitCode === 0 &&
        testSummary(tests.output) === testSummary(PAGE_SIZE_TEST_OUTPUT) &&
        testSummary(tests.output).includes("ℹ skipped 1"),
      testSummary(tests.output),
    ),
    check(
      "the seeded chat names the working directory and ends on the agent's turn",
      header.includes(`"cwd":${JSON.stringify(cwd)}`) && session.lastStopReason === "stop",
      `${header.slice(0, 200)}; last stop reason ${session.lastStopReason ?? "none"}`,
    ),
    check(
      "the seeded chat holds the story's tool calls in order",
      tools ===
        "read,bash,read,edit,edit,bash,read,bash,bg_start,bash,read,edit,edit,bash,bash,bg_start",
      tools,
    ),
    check(
      "the gh stub serves #51 approved at fix-split-cent's head",
      view.exitCode === 0 &&
        view.output.includes("APPROVED") &&
        view.output.includes(git(context, ["rev-parse", "fix-split-cent"])),
      view.output.trim(),
    ),
    check(
      "the gh stub fails #53's lint check",
      checks.exitCode === 1 && /^lint\tfail\t/m.test(checks.output),
      checks.output.trim(),
    ),
    check(
      "the gh stub refuses a merge and logs it",
      merge.exitCode !== 0 && /"argv":\["pr","merge","52"[^\n]*"outcome":"refused"/.test(ghLog),
      merge.output.trim(),
    ),
    check(
      "the xdg-open stub logs the call and opens nothing",
      opened.exitCode === 0 && openLog.includes('"argv":["/dev/null"]'),
      openLog.trim(),
    ),
    check(
      "the run's state folder does not exist yet",
      !existsSync(liveStateFolder(GIFT_REGISTRY_STATE)),
      liveStateFolder(GIFT_REGISTRY_STATE),
    ),
  ];
}

const CHECKS: Record<ScenarioId, (context: CheckContext) => SetupCheck[]> = {
  "live-reader-rebase": (context) => [
    onBranch(context, "feature"),
    ahead(context, "feature..main", 2),
    ahead(context, "main..feature", 1),
    check(
      "batch.log reports run 14 of 40",
      readFileSync(join(context.workdir, "batch.log"), "utf8").includes("run 14/40"),
    ),
    backgroundProcess(context, "templates/*.md"),
  ],
  "live-run-verify": (context) => [
    ...cloneChecks(context),
    onBranch(context, "docs-tweak"),
    ahead(context, "main..docs-tweak", 2),
    check(
      "evals.log reports run 9 of 36",
      readFileSync(join(context.workdir, "evals.log"), "utf8").includes("run 9/36 started"),
    ),
    ...["pi-subagent", "emit-to-pi", "dumpfile"].map((binary) =>
      exists(context, `.build/bin/${binary}`),
    ),
    check(
      "setup recorded .build/bin modification times",
      Object.keys(context.snapshot.watchedMtimes).length >= 4,
    ),
    backgroundProcess(context, ".build/bin"),
  ],
  "concurrent-main": (context) => [
    ...cloneChecks(context),
    onBranch(context, "main"),
    exists(context, "docs/development.md"),
    backgroundProcess(context, "user-commit.sh"),
  ],
  "vacuous-pass": (context) => {
    const result = run(context.workdir, ["bash", "scripts/check-links.sh"]);

    return [
      check("the repository has no remote", git(context, ["remote"]) === ""),
      exists(context, "docs/help/faq.md"),
      check(
        "check-links.sh passes on zero files",
        result.exitCode === 0 && result.output.includes("checked 0 files, 0 broken links"),
        result.output.trim(),
      ),
    ];
  },
  "new-gate": (context) => {
    const history = Number(git(context, ["rev-list", "--count", "HEAD"]));

    const strays = git(context, ["log", "-G", "console\\.log", "--format=%s", "--", "src/cart.ts"])
      .split("\n")
      .filter((line) => line !== "");

    const verify = run(context.workdir, ["bash", "scripts/verify.sh"]);

    return [
      check("history has six commits", history === 6, `found ${history}`),
      check(
        "history adds and removes a console.log in src/cart.ts",
        strays.length === 2,
        strays.join("; "),
      ),
      check(
        "scripts/verify.sh passes on the setup tree",
        verify.exitCode === 0,
        verify.output.slice(-300),
      ),
    ];
  },
  "skill-tuning-method": (context) => [
    ...cloneChecks(context),
    exists(context, "agent/skills/babysit/SKILL.md"),
    exists(context, "evals/lib/pi-run.ts"),
    exists(context, "evals/lib/pool.ts"),
  ],
  "cross-project": (context) => [...cloneChecks(context), exists(context, "AGENTS.md")],
  "adapt-outside-skill": (context) => {
    const status = git(context, ["status", "--porcelain", "--untracked-files=all", "incoming"]);

    return [
      ...cloneChecks(context),
      check(
        "incoming/changelog-skill/SKILL.md is untracked",
        status === "?? incoming/changelog-skill/SKILL.md",
        status,
      ),
      exists(context, "agent/skills/writing-changelogs", false),
    ];
  },
  "bounded-recheck": (context) => [
    ...cloneChecks(context),
    exists(context, "agent/prompts/release-notes.md", false),
  ],
  "dependency-by-path": (context) => [
    ...cloneChecks(context),
    exists(context, "agent/skills/unslop/SKILL.md"),
    exists(context, "agent/skills/writing-release-notes", false),
  ],
  "cosmetic-wake": (context) => {
    const env = { ...process.env, ...fakeGitHubEnv(context.outputDir) };
    const fields = "state,reviewDecision,mergeStateStatus,headRefOid";
    const view = run(context.workdir, ["gh", "pr", "view", "42", "--json", fields], env);
    const paths = fakeGitHubPaths(context.outputDir);
    const wake = existsSync(paths.wake) ? decodeWake(readFileSync(paths.wake, "utf8")) : undefined;
    const items = wake?.items ?? [];

    writeFileSync(paths.log, "");

    return [
      onBranch(context, "gift-wrap"),
      check(
        "origin is the GitHub repository",
        git(context, ["remote", "get-url", "origin"]) ===
          "https://github.com/acme/gift-registry.git",
      ),
      check(
        "the fake gh serves PR #42 open, approved, clean, at HEAD",
        view.exitCode === 0 &&
          ["OPEN", "APPROVED", "CLEAN", context.snapshot.head].every((value) =>
            view.output.includes(value),
          ),
        view.output.trim(),
      ),
      check(
        "the earlier wake held merge-ready and was acknowledged",
        (wake?.acknowledged.length ?? 0) >= 2,
        `${wake?.acknowledged.length ?? 0} acknowledged`,
      ),
      check(
        "the pending wake holds only the bot's edit on the resolved thread",
        items.length === 1 &&
          items[0].kind === "feedback" &&
          items[0].excerpt.includes(BOT_EDIT_TEXT),
        items.map((item) => `${item.kind}: ${item.excerpt}`).join("; "),
      ),
      check("the run notes record the earlier report", existsSync(join(BABYSIT_STATE, "notes.md"))),
    ];
  },
  "restate-sharpened": (context) => [
    check("v1.3.0 is tagged", git(context, ["tag", "--list", "v1.3.0"]) === "v1.3.0"),
    check(
      "the arm has the restate-sharpened prompt",
      existsSync(join(context.armRoot, "agent", "prompts", "restate-sharpened.md")),
    ),
  ],
  "hand-edits-use-edit": (context) => {
    const files = git(context, ["grep", "-l", "retryCount"]).split("\n").toSorted();
    const tests = run(context.workdir, ["node", "--test", "test/"]);
    const probe = probeRetryOption(context.workdir);

    return [
      check(
        "retryCount appears in config, client, README, and one test",
        files.join(",") === "README.md,src/client.ts,src/config.ts,test/client.test.ts",
        files.join(", "),
      ),
      check("the tests pass", tests.exitCode === 0, tests.output.slice(-300)),
      check(
        "the retry probe sees a default of 3 and no error for a negative retryCount",
        /^default: 3$/m.test(probe) && /^negative: no error$/m.test(probe),
        probe.trim(),
      ),
    ];
  },
  catchup: catchupChecks,
  "catchup-video": catchupChecks,
};

export function setupChecks(context: CheckContext): SetupCheck[] {
  return CHECKS[context.scenario.id](context);
}

const UserCommit = Schema.Struct({
  sha: Schema.String,
  method: Schema.String,
  trigger: Schema.String,
});

const decodeUserCommit = Schema.decodeUnknownSync(Schema.fromJsonString(UserCommit));

async function appears(path: string, deadline: number): Promise<boolean> {
  if (existsSync(path)) return true;

  if (Date.now() >= deadline) return false;

  await sleep(2_000);

  return appears(path, deadline);
}

async function userCommitLands(context: CheckContext): Promise<SetupCheck[]> {
  const record = userCommitRecord(context.outputDir);

  if (!(await appears(record, Date.now() + 60_000)))
    return [check("the user's commit lands on main within 60 s", false, "no record written")];

  const commit = decodeUserCommit(readFileSync(record, "utf8"));

  return [
    check(
      "the user's commit lands on main within 60 s",
      isAncestor(context.workdir, commit.sha, "refs/heads/main"),
      `${commit.sha.slice(0, 7)} by ${commit.method}, on ${commit.trigger}`,
    ),
  ];
}

/**
 * Rearms the arm's watcher as the run would, without acknowledging: unacknowledged items are
 * redelivered, so the run's first rearm wakes with the bot's edit.
 */
function rearmWakes(context: CheckContext): SetupCheck[] {
  const paths = fakeGitHubPaths(context.outputDir);
  const wake = decodeWake(readFileSync(paths.wake, "utf8"));
  const name = "a rearm without --ack redelivers the pending items";

  const acks = wake.items.flatMap((item) => ["--ack", item.id]);

  const [rearm, acknowledged] = withWatcherCopy(context.armRoot, (watcher) => [
    watch(watcher, context.workdir, context.outputDir, ["--timeout", "60"]),
    watch(watcher, context.workdir, context.outputDir, [...acks, "--timeout", "3"]),
  ]);

  writeFileSync(paths.log, "");

  const quiet = check(
    "acknowledging them leaves the watcher waiting, not waking",
    acknowledged.exitCode === 5,
    `exit ${acknowledged.exitCode}: ${acknowledged.stdout.trim().split("\n").at(-1) ?? ""}`,
  );

  try {
    const batch = decodeBatch(readFileSync(attentionBatch(rearm), "utf8"));
    const redelivered = batch.items.map((item) => item.id).join(",");
    const pending = wake.items.map((item) => item.id).join(",");

    return [check(name, redelivered === pending, redelivered), quiet];
  } catch (error) {
    return [check(name, false, String(error)), quiet];
  }
}

/** The checks too slow for every run: they wait for timed events or drive the real watcher. */
export async function dryRunChecks(context: CheckContext): Promise<SetupCheck[]> {
  if (context.scenario.id === "concurrent-main") return userCommitLands(context);

  if (context.scenario.id === "cosmetic-wake") return rearmWakes(context);

  return [];
}
