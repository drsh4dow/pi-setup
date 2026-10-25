#!/usr/bin/env node
// Records a real Pi session for the catchup-video-recorded scenario (recorded.ts). It cuts the
// session at the end of the stretch of autonomous work with the most PRs and events, just before
// the next user message, so the window starts at the user message that opened the stretch. It
// snapshots every PR the window names, once and read-only, with `gh pr view --json`, and bundles
// the session's repository at the commit its branch held at the cut. Known secret formats are
// replaced in everything it writes; the report names their kind and line, never their value.
//
//   node evals/harness-lessons/record-session.ts --session <file.jsonl> [--name default] \
//     [--own-state <state folder name>]... [--state <dir>] [--stretch <n>] [--repo <dir>] [--list]
//
// --state names the session's own state folder as it is on disk now, which may differ from the
// name the session used. The recording keeps a snapshot of it at the cut (snapshotState).
//
// The ground truth for grading, story.md, is written by hand into the recording afterwards.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { Option, Schema } from "effect";
import { writeAtomically } from "../lib/pi-run.ts";
import { RECORDINGS, recordingFiles, snapshotState, type Recording } from "./recorded.ts";

const Entry = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  customType: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(
    Schema.Struct({ role: Schema.String, stopReason: Schema.optionalKey(Schema.String) }),
  ),
});

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Entry));

const Header = Schema.Struct({ type: Schema.Literal("session"), cwd: Schema.String });

const decodeHeader = Schema.decodeUnknownSync(Schema.fromJsonString(Header));

type Entry = typeof Entry.Type;

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/** A user message and the autonomous work after it, up to the next user message. */
export interface Stretch {
  /** Line numbers: the user message, and the last assistant message that ended a turn. */
  readonly start: number;
  readonly cut: number;
  readonly prs: readonly string[];
  readonly events: number;
  readonly toolCalls: number;
}

const isUser = (entry: Entry | undefined) => entry?.message?.role === "user";

/** Every stretch of the session, in order. A stretch with no finished turn has no cut. */
export function stretches(lines: readonly string[]): Stretch[] {
  const entries = lines.map((line) => Option.getOrUndefined(decodeEntry(line)));
  const starts = entries.flatMap((entry, index) => (isUser(entry) ? [index] : []));

  return starts.flatMap((start, which) => {
    const end = starts[which + 1] ?? lines.length;
    const inside = lines.slice(start, end).join("\n");

    const cut = entries.findLastIndex(
      (entry, index) =>
        index > start &&
        index < end &&
        entry?.message?.role === "assistant" &&
        entry.message.stopReason === "stop",
    );

    if (cut === -1) return [];

    return [
      {
        start,
        cut,
        prs: [...new Set([...inside.matchAll(PR_URL)].map((match) => match[0]))],
        events: entries.slice(start, end).filter((entry) => entry?.type === "custom_message")
          .length,
        toolCalls: (inside.match(/"type":"toolCall"/g) ?? []).length,
      },
    ];
  });
}

/** Secret formats replaced in a recording, by kind. */
const SECRETS: readonly (readonly [string, RegExp])[] = [
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["github fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ["openai or anthropic key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["linear key", /\blin_api_[A-Za-z0-9]{30,}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];

/** `lines` with every known secret format replaced, and where each kind was found. */
export function redact(lines: readonly string[], firstLine = 0) {
  const found = new Map<string, number[]>();

  const clean = lines.map((line, index) =>
    SECRETS.reduce(
      (text, [kind, pattern]) =>
        text.replace(pattern, () => {
          const at = found.get(kind) ?? [];

          if (at.at(-1) !== firstLine + index) at.push(firstLine + index);
          found.set(kind, at);

          return `[REDACTED ${kind}]`;
        }),
      line,
    ),
  );

  return { clean, found: [...found].map(([kind, at]) => ({ kind, lines: at })) };
}

/** One PR as `gh pr view --json` gives it, kept whole for the stub's `--json` selections. */
const decodePrFields = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const PR_FIELDS =
  "number,title,url,state,isDraft,author,headRefName,baseRefName,headRefOid,mergeStateStatus,mergeable,reviewDecision,reviews,latestReviews,reviewRequests,statusCheckRollup,createdAt,updatedAt,mergedAt,closedAt,mergedBy,additions,deletions,changedFiles,body,labels,comments";

const run = (command: string, args: readonly string[], cwd?: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** The repository at `commit`, alone, as a bundle whose one branch is `recorded`. */
function bundle(repo: string, commit: string, out: string) {
  const scratch = mkdtempSync(join(tmpdir(), "record-session-"));
  const bare = join(scratch, "repo.git");

  try {
    run("git", ["clone", "--quiet", "--bare", "--no-local", repo, bare]);
    run("git", ["update-ref", "refs/heads/recorded", commit], bare);
    run("git", ["bundle", "create", "--quiet", out, "refs/heads/recorded"], bare);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function usage(message: string): never {
  console.error(
    `${message}\nusage: node evals/harness-lessons/record-session.ts --session <file.jsonl> [--name default] [--own-state <name>]... [--state <dir>] [--stretch <n>] [--repo <dir>] [--list]`,
  );
  process.exit(2);
}

function main() {
  const { values } = parseArgs({
    options: {
      session: { type: "string" },
      name: { type: "string", default: "default" },
      "own-state": { type: "string", multiple: true, default: [] },
      state: { type: "string" },
      stretch: { type: "string" },
      repo: { type: "string" },
      list: { type: "boolean", default: false },
    },
  });

  if (values.session === undefined) usage("--session is required");

  const lines = readFileSync(values.session, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");

  const header = decodeHeader(lines[0] ?? "");
  const all = stretches(lines);
  const score = (stretch: Stretch) => stretch.prs.length + stretch.events;

  for (const [index, stretch] of all.entries())
    console.log(
      `${index}\tlines ${stretch.start}-${stretch.cut}\t${stretch.prs.length} PRs\t${stretch.events} events\t${stretch.toolCalls} tool calls`,
    );

  if (values.list) return;

  const chosen =
    values.stretch === undefined
      ? all.reduce<Stretch | undefined>(
          (best, stretch) => (best === undefined || score(stretch) > score(best) ? stretch : best),
          undefined,
        )
      : all[Number(values.stretch)];

  if (chosen === undefined) usage("the session has no stretch that ends on a finished turn");

  const cutAt = Option.getOrUndefined(decodeEntry(lines[chosen.cut] ?? ""))?.timestamp;

  if (cutAt === undefined) usage(`line ${chosen.cut} has no timestamp`);

  const repo = values.repo ?? header.cwd;
  const branch = run("git", ["symbolic-ref", "--short", "HEAD"], repo).trim();
  const commit = run("git", ["rev-list", "-1", `--before=${cutAt}`, branch], repo).trim();
  const dir = join(RECORDINGS, values.name);
  const files = recordingFiles(dir);

  mkdirSync(dir, { recursive: true });

  const session = redact(lines.slice(0, chosen.cut + 1));

  writeAtomically(files.session, `${session.clean.join("\n")}\n`);

  const snapshot = chosen.prs.map((url) =>
    decodePrFields(run("gh", ["pr", "view", url, "--json", PR_FIELDS])),
  );

  const prs = redact(JSON.stringify(snapshot, null, 2).split("\n"));

  writeAtomically(files.prs, `${prs.clean.join("\n")}\n`);
  bundle(repo, commit, files.bundle);

  const omitted =
    values.state === undefined ? undefined : snapshotState(values.state, cutAt, files.state);

  let recording: Recording = {
    source: basename(values.session),
    cwd: header.cwd,
    ownStateFolders: values["own-state"],
    branch,
    commit,
    windowStart: chosen.start,
    cut: chosen.cut,
    cutAt,
    prs: chosen.prs,
    redactions: [
      ...session.found,
      ...prs.found.map(({ kind, lines: at }) => ({ kind: `${kind} in prs.json`, lines: at })),
    ],
  };

  if (values.state !== undefined && omitted !== undefined)
    recording = { ...recording, state: { from: values.state, omitted } };

  writeFileSync(files.recording, `${JSON.stringify(recording, null, 2)}\n`);

  console.log(
    [
      `recorded lines ${chosen.start}-${chosen.cut} (${chosen.prs.length} PRs, ${chosen.events} events) into ${dir}`,
      `repository ${repo} at ${commit} on ${branch}, cut at ${cutAt}`,
      ...recording.redactions.map(
        (found) => `redacted ${found.kind} on lines ${found.lines.join(", ")}`,
      ),
      ...(omitted ?? []).map(
        (path) => `left out ${path} from the state snapshot: it changed after the cut`,
      ),
      `write the ground truth to ${files.story}`,
    ].join("\n"),
  );
}

if (import.meta.main) main();
