// The catchup-video-recorded scenario continues a real session instead of an invented one. A
// recording (record-session.ts makes it) holds the session cut at the end of a stretch of
// autonomous work, a read-only snapshot of every PR that stretch names, a bundle of the
// repository at the commit the session ended on, and the ground truth for grading (story.md,
// written by hand). Recordings hold company data, so they live in the pi-setup state folder, never
// in the repository; CATCHUP_RECORDING names the one to load, `default` without it.
//
// The machine has moved on since the cut: the session's state folder, its later sessions, and the
// repository hold what happened next, and the ground truth sits in the recording. A run sees none
// of it. Pi runs in a mount namespace (bwrap) where those paths are empty, and its state folder
// starts as the recording's snapshot of the session's own state folder at the cut.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { Option, Schema } from "effect";
import type { CatchupTruth } from "./grade-catchup.ts";
import { unknown, type Unknown } from "./metrics.ts";
import { liveStateFolder } from "./state-folder.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

/**
 * The state folder of the recorded runs. Their `origin` is a local bare repository of this name,
 * never the recorded repository's own, whose real state folder the runner would move away.
 */
export const RECORDED_STATE = "catchup-recorded";

export const RECORDINGS = join(liveStateFolder("pi-setup"), "catchup-port", "recorded");

export function recordingDir(): string {
  return join(RECORDINGS, process.env.CATCHUP_RECORDING ?? "default");
}

export const Recording = Schema.Struct({
  /** The session file the recording was cut from. */
  source: Schema.String,
  /** The session's working directory, which the seeded chat names as the run's own. */
  cwd: Schema.String,
  /** Names of the state folders the session wrote, which the seeded chat names as the run's. */
  ownStateFolders: Schema.Array(Schema.String),
  branch: Schema.String,
  /** The commit of `branch` when the session was cut. */
  commit: Schema.String,
  /** Line numbers in the source: the window's user message and the last line kept. */
  windowStart: Schema.Int,
  cut: Schema.Int,
  cutAt: Schema.String,
  prs: Schema.Array(Schema.String),
  /** Secrets replaced in the recording: the kind of each and the source lines it was on. */
  redactions: Schema.Array(Schema.Struct({ kind: Schema.String, lines: Schema.Array(Schema.Int) })),
  /**
   * The snapshot in state/ of the session's own state folder: the folder it was taken from, and
   * the files left out because they changed after the cut. Absent when there is none.
   */
  state: Schema.optional(
    Schema.Struct({ from: Schema.String, omitted: Schema.Array(Schema.String) }),
  ),
});

export type Recording = typeof Recording.Type;

export const decodeRecording = Schema.decodeUnknownSync(Schema.fromJsonString(Recording));

export function recordingFiles(dir: string) {
  return {
    recording: join(dir, "recording.json"),
    session: join(dir, "session.jsonl"),
    prs: join(dir, "prs.json"),
    bundle: join(dir, "repo.bundle"),
    story: join(dir, "story.md"),
    state: join(dir, "state"),
  };
}

export function loadRecording(dir = recordingDir()): Recording {
  const files = recordingFiles(dir);

  if (!existsSync(files.recording))
    throw new Error(
      `no recording at ${dir}: make one with node evals/harness-lessons/record-session.ts --session <file>, or set CATCHUP_RECORDING to the name of one under ${RECORDINGS}`,
    );

  return decodeRecording(readFileSync(files.recording, "utf8"));
}

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `path` as a whole path, not the start of a longer name: `/a/b` but not `/a/bc`. */
export const wholePath = (path: string) => new RegExp(`${escape(path)}(?![\\w.-])`, "g");

/**
 * The recorded session for a run in `cwd`: its working directory and its own state folders
 * renamed to the run's, so the run reads and writes where the runner looks.
 */
export function recordedChat(cwd: string): string {
  const recording = loadRecording();
  const state = liveStateFolder(RECORDED_STATE);

  const named = recording.ownStateFolders.flatMap((name) => [
    join(homedir(), ".local", "state", "pi-agent", name),
    `~/.local/state/pi-agent/${name}`,
  ]);

  return named.reduce(
    (jsonl, path) => jsonl.replace(wholePath(path), state),
    readFileSync(recordingFiles(recordingDir()).session, "utf8").replace(
      wholePath(recording.cwd),
      cwd,
    ),
  );
}

const git = (cwd: string, args: readonly string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/**
 * A clone of the recorded repository at the recorded commit, on the recorded branch. Its `origin`
 * is a local bare repository named RECORDED_STATE holding that branch, so a push reaches no
 * network. Setup's git status goes to `setup-status.txt` in `outputDir`.
 */
export function prepareRecordedWorkdir(outputDir: string): string {
  const dir = recordingDir();
  const recording = loadRecording(dir);
  const workdir = mkdtempSync(join(tmpdir(), "catchup-recorded-"));
  const origin = join(mkdtempSync(join(tmpdir(), "catchup-origin-")), `${RECORDED_STATE}.git`);

  git(workdir, ["clone", "--quiet", "--branch", "recorded", recordingFiles(dir).bundle, "."]);
  git(workdir, ["branch", "--move", "recorded", recording.branch]);
  git(workdir, ["remote", "remove", "origin"]);
  git(tmpdir(), ["init", "--quiet", "--bare", "-b", recording.branch, origin]);
  git(workdir, ["remote", "add", "origin", origin]);
  git(workdir, ["push", "--quiet", "-u", "origin", recording.branch]);
  git(workdir, ["remote", "set-head", "origin", recording.branch]);
  copyFileSync(recordingFiles(dir).prs, runPrs(outputDir));

  writeFileSync(
    join(outputDir, "setup-status.txt"),
    git(workdir, ["status", "--porcelain=v1", "--untracked-files=all"]),
  );

  return workdir;
}

/** The run's copy of the PR snapshot, since the run cannot see the recording. */
const runPrs = (outputDir: string) => join(outputDir, "recorded-prs.json");

/**
 * Copies into `to` each file under `from` that existed at `cutAt` and has not changed since,
 * keeping its times. Returns the files left out because they changed after the cut, relative to
 * `from`: their content at the cut is gone.
 */
export function snapshotState(from: string, cutAt: string, to: string): string[] {
  const cut = Date.parse(cutAt);
  const omitted: string[] = [];

  rmSync(to, { recursive: true, force: true });

  for (const entry of readdirSync(from, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const path = join(entry.parentPath, entry.name);
    const { birthtimeMs, mtimeMs } = statSync(path);

    if (birthtimeMs > cut) continue;

    if (mtimeMs > cut) {
      omitted.push(relative(from, path));
      continue;
    }

    mkdirSync(join(to, relative(from, entry.parentPath)), { recursive: true });
    cpSync(path, join(to, relative(from, path)), { preserveTimestamps: true });
  }

  return omitted.toSorted();
}

/** Creates the run's state folder: the recording's snapshot at the cut, or empty. */
export function seedRecordedState(): string {
  const live = liveStateFolder(RECORDED_STATE);
  const snapshot = recordingFiles(recordingDir()).state;

  if (existsSync(snapshot)) cpSync(snapshot, live, { recursive: true, preserveTimestamps: true });
  else mkdirSync(live, { recursive: true });

  return live;
}

/** The environment that puts the recorded `gh` and the logging `xdg-open` first on PATH. */
export function recordedStubEnv(outputDir: string): NodeJS.ProcessEnv {
  return {
    PATH: `${join(HERE, "recorded-bin")}${delimiter}${process.env.PATH ?? ""}`,
    CATCHUP_LOG_DIR: outputDir,
    RECORDED_PRS: runPrs(outputDir),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** The section of `markdown` under `heading`, up to the next heading of the same level. */
export function section(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);

  if (start === -1) return undefined;

  const level = /^#+/.exec(heading)?.[0] ?? "#";

  const end = lines.findIndex(
    (line, index) => index > start && new RegExp(`^#{1,${level.length}}\\s`).test(line),
  );

  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

export const CALLS_HEADING = "## Calls waiting on the user";

const RecordLine = Schema.Struct({
  message: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
    }),
  ),
});

const decodeRecordLine = Schema.decodeUnknownOption(Schema.fromJsonString(RecordLine));

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const isText = Schema.is(TextPart);

const isString = Schema.is(Schema.String);

const PrState = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  mergeStateStatus: Schema.optional(Schema.String),
  reviewDecision: Schema.optional(Schema.String),
});

const decodePrStates = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(PrState)));

/**
 * What the replay cannot reproduce. The recorded session's subagents and background terminals
 * ran on the original machine; in a replay they do not exist, so a run finds them gone.
 */
const REPLAY_GAPS =
  "The replay: subagents, background terminals, and live checks that were running at the cut do not exist in it. A run that finds them gone and says they never reported back, or that it will start them again, states what it saw, not an invention.";

/**
 * What a recorded run could read besides story.md: what the user and the agent wrote from the
 * window's start to the cut, and each PR's state in the snapshot the gh stub serves. story.md is
 * a summary of hours of work, so a fact a run took from these is not invented.
 */
export function recordedRecord(dir = recordingDir()): string {
  const recording = loadRecording(dir);
  const files = recordingFiles(dir);

  const said = readFileSync(files.session, "utf8")
    .split("\n")
    .slice(recording.windowStart - 1)
    .flatMap((line) => {
      const message = Option.getOrUndefined(decodeRecordLine(line))?.message;

      if (message === undefined || (message.role !== "user" && message.role !== "assistant"))
        return [];

      const parts = isString(message.content)
        ? [message.content]
        : message.content.filter(isText).map((part) => part.text);

      return parts.filter((text) => text.trim() !== "").map((text) => `${message.role}: ${text}`);
    });

  const prs = decodePrStates(readFileSync(files.prs, "utf8")).map(
    (pr) =>
      `${pr.url} "${pr.title}": ${pr.state}, merge state ${pr.mergeStateStatus ?? "unknown"}, review ${pr.reviewDecision ?? "none"}`,
  );

  return [
    "The chat from the user's last message to the cut:",
    ...said,
    "",
    "The PRs as the gh stub serves them:",
    ...prs,
    "",
    REPLAY_GAPS,
  ].join("\n");
}

/** The recording's ground truth, or why there is none. */
export function recordedTruth(): CatchupTruth | Unknown {
  const story = recordingFiles(recordingDir()).story;

  if (!existsSync(story)) return unknown(`no ground truth at ${story}`);

  const text = readFileSync(story, "utf8");

  return {
    liveState: liveStateFolder(RECORDED_STATE),
    calls: section(text, CALLS_HEADING) ?? text,
    sharedCall:
      "For a call that covers several PRs, each PR needs its own line with its own change, evidence, and risk.",
    story: text,
    record: recordedRecord(),
  };
}
