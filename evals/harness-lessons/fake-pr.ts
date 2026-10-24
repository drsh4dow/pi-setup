// The cosmetic-wake scenario's PR and its watch history. Setup serves PR #42 through the fake
// `gh`, runs the arm's own babysit watcher through the earlier wake that reported merge-ready,
// acknowledges it, and then lets the bot edit its comment, so the watcher's next wake is real
// and holds only that edit.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Option, Schema } from "effect";
import { gitOutput, writeAtomically } from "../lib/pi-run.ts";
import type { FakeGitHub } from "./fakegh-state.ts";
import { initialFakeGitHub, withBotEdit } from "./fakegh-state.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

export function fakeGitHubPaths(outputDir: string) {
  return {
    state: join(outputDir, "gh-state.json"),
    log: join(outputDir, "gh-log.jsonl"),
    /** The record of the wake setup left pending for the run. */
    wake: join(outputDir, "babysit-wake.json"),
  };
}

/** The environment that puts the fake `gh` first on PATH, serving the run's PR. */
export function fakeGitHubEnv(outputDir: string): NodeJS.ProcessEnv {
  const paths = fakeGitHubPaths(outputDir);

  return {
    PATH: `${join(HERE, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    FAKEGH_STATE: paths.state,
    FAKEGH_LOG: paths.log,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Every babysit state of the fake repository, cleared before each run. */
export const BABYSIT_ROOT = join(homedir(), ".local", "state", "pi-agent", "gift-registry");

/** The state directory the babysit skill names for one PR: `<repo>/babysit/<pr>`. */
export const BABYSIT_STATE = join(BABYSIT_ROOT, "babysit", "42");

export const WATCH_SCOPE = ["--owner", "acme", "--repo", "gift-registry", "--pr", "42"] as const;

const BatchItem = Schema.Struct({ id: Schema.String, kind: Schema.String, excerpt: Schema.String });

const Batch = Schema.Struct({ items: Schema.Array(BatchItem) });

const Attention = Schema.Struct({
  kind: Schema.Literal("ATTENTION"),
  batch: Schema.Struct({ path: Schema.String }),
});

export const decodeBatch = Schema.decodeUnknownSync(Schema.fromJsonString(Batch));

const decodeAttention = Schema.decodeUnknownOption(Schema.fromJsonString(Attention));

export const Wake = Schema.Struct({
  batchPath: Schema.String,
  items: Schema.Array(BatchItem),
  /** The ids setup acknowledged for the earlier wake. */
  acknowledged: Schema.Array(Schema.String),
});

export type Wake = typeof Wake.Type;

export const decodeWake = Schema.decodeUnknownSync(Schema.fromJsonString(Wake));

export interface WatchResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `use` with a temporary copy of the arm's watcher, so its first-run dependency install
 * writes nothing into the arm's checkout or the results.
 */
export function withWatcherCopy<T>(armRoot: string, use: (watcher: string) => T): T {
  const scripts = mkdtempSync(join(tmpdir(), "watch-pr-"));

  try {
    cpSync(join(armRoot, "agent", "skills", "babysit", "scripts"), scripts, {
      recursive: true,
      filter: (source) => !source.includes("node_modules"),
    });

    return use(join(scripts, "watch-pr"));
  } finally {
    rmSync(scripts, { recursive: true, force: true });
  }
}

/** One watcher run against the fake GitHub, bounded by the watcher's own deadline. */
export function watch(
  watcher: string,
  workdir: string,
  outputDir: string,
  extra: readonly string[],
): WatchResult {
  const result = spawnSync(
    watcher,
    ["--until-merged", "--state", BABYSIT_STATE, ...WATCH_SCOPE, "--interval", "1", ...extra],
    {
      cwd: workdir,
      encoding: "utf8",
      env: { ...process.env, ...fakeGitHubEnv(outputDir) },
      timeout: 3 * 60_000,
    },
  );

  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The batch an ATTENTION exit names, or the watcher's output when it did not wake. */
export function attentionBatch(result: WatchResult): string {
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  const attention = decodeAttention(last);

  if (result.exitCode !== 8 || Option.isNone(attention)) {
    throw new Error(
      `watch-pr exited ${result.exitCode} without ATTENTION:\n${result.stdout}${result.stderr}`.slice(
        0,
        2000,
      ),
    );
  }

  return attention.value.batch.path;
}

function writeState(outputDir: string, state: FakeGitHub) {
  writeAtomically(fakeGitHubPaths(outputDir).state, `${JSON.stringify(state, null, 2)}\n`);
}

const NOTES = (
  armRoot: string,
  merged: string,
  acknowledged: readonly string[],
  batchPath: string,
) => `# Babysit acme/gift-registry#42

- Mode: until-merged
- State: ${BABYSIT_STATE}
- Command: ${join(armRoot, "agent", "skills", "babysit", "scripts", "watch-pr")} --until-merged --state ${BABYSIT_STATE} ${WATCH_SCOPE.join(" ")}

## Waves

- First arm: the batch held the PR's history (both reviews, the walkthrough comment) and merge-ready at ${merged.slice(0, 7)}. Nothing to fix. Reported merge-ready to the operator; merging stays with them. Acknowledged ${acknowledged.length} items and rearmed.
- The watcher woke again: ATTENTION, batch ${batchPath}
`;

/**
 * Serves PR #42 and replays the watch so far with the arm's own watcher: the first arm wakes
 * with the PR's history and merge-ready, which is acknowledged as reported; then the bot edits
 * its comment on the resolved thread and the watcher wakes again. That wake stays unacknowledged
 * for the run to handle.
 */
export function preparePriorWatch(workdir: string, armRoot: string, outputDir: string) {
  const paths = fakeGitHubPaths(outputDir);
  const headRefOid = gitOutput(workdir, ["rev-parse", "HEAD"]);
  const initial = initialFakeGitHub({ headRefOid, now: new Date() });

  writeState(outputDir, initial);
  rmSync(BABYSIT_ROOT, { recursive: true, force: true });
  mkdirSync(BABYSIT_STATE, { recursive: true });

  const wake = withWatcherCopy(armRoot, (watcher): Wake => {
    const firstWake = watch(watcher, workdir, outputDir, ["--timeout", "60"]);
    const first = decodeBatch(readFileSync(attentionBatch(firstWake), "utf8"));
    const acknowledged = first.items.map((item) => item.id);
    const acks = acknowledged.flatMap((id) => ["--ack", id]);
    const quiet = watch(watcher, workdir, outputDir, [...acks, "--timeout", "3"]);

    if (quiet.exitCode === 8) {
      throw new Error(`the acknowledged watcher woke again:\n${quiet.stdout}`);
    }

    writeState(outputDir, withBotEdit(initial, new Date()));

    const batchPath = attentionBatch(watch(watcher, workdir, outputDir, ["--timeout", "60"]));

    return { batchPath, items: decodeBatch(readFileSync(batchPath, "utf8")).items, acknowledged };
  });

  const { batchPath, acknowledged } = wake;

  writeFileSync(
    join(BABYSIT_STATE, "notes.md"),
    NOTES(armRoot, headRefOid, acknowledged, batchPath),
  );
  writeAtomically(paths.wake, `${JSON.stringify(wake, null, 2)}\n`);

  // Setup's own calls are history the run did not make.
  writeFileSync(paths.log, "");
}
