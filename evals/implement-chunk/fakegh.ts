#!/usr/bin/env node
// A `gh` for one run's repository, backed by the run's bare origin, so the whole chunk runs
// without GitHub. It serves every pull request the run opens, CI on each head, the review bot,
// and the merge settings, from the state in $FAKEGH_STATE. Every call appends one JSON line to
// $FAKEGH_LOG with its exit code and the change it made, if any.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Schema } from "effect";
import { graphql, requestFields, rest } from "./gh-api.ts";
import { fail, GhExit, GitHubChange, type Context, type Outcome } from "./gh-ops.ts";
import { pick, prCommand, stringOf, stringsOf } from "./gh-pr.ts";
import { advance, FakeGitHub } from "./gh-state.ts";
import { sleep, withLock } from "./lock.ts";
import { json } from "./gh-views.ts";

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(FakeGitHub));

export const GhLogEntry = Schema.Struct({
  at: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  exitCode: Schema.Int,
  change: Schema.NullOr(GitHubChange),
  stderr: Schema.String,
});

export type GhLogEntry = typeof GhLogEntry.Type;

export interface GhPaths {
  readonly state: string;
  readonly log: string;
}

export function readGitHub(path: string): FakeGitHub {
  return decodeState(readFileSync(path, "utf8"));
}

export function writeGitHub(path: string, state: FakeGitHub) {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, json(state));
  renameSync(temporary, path);
}

/** The requested `--json` fields of an object, failing as gh does on an unknown one. */
function conclusionOf(passed: boolean | null): string {
  if (passed === null) return "";

  return passed ? "success" : "failure";
}

function repoView(state: FakeGitHub, args: readonly string[]): Outcome {
  const { values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: { json: { type: "string" }, jq: { type: "string", short: "q" } },
  });

  const all = {
    name: state.repo,
    owner: { login: state.owner },
    nameWithOwner: `${state.owner}/${state.repo}`,
    url: `https://github.com/${state.owner}/${state.repo}`,
    defaultBranchRef: { name: state.defaultBranch },
    mergeCommitAllowed: state.settings.mergeCommitAllowed,
    squashMergeAllowed: state.settings.squashMergeAllowed,
    rebaseMergeAllowed: state.settings.rebaseMergeAllowed,
    autoMergeAllowed: false,
    deleteBranchOnMerge: false,
    visibility: "PRIVATE",
    isPrivate: true,
  };

  const fields = stringOf(values, "json");

  if (fields !== undefined) return { stdout: json(pick(all, fields)), state, change: null };

  return {
    stdout: `${all.nameWithOwner}\nTally: unit conversions over HTTP.\n`,
    state,
    change: null,
  };
}

function runCommand(state: FakeGitHub, sub: string | undefined): Outcome {
  const runs = state.ci.map((ciRun, index) => ({
    databaseId: index + 1,
    name: "CI",
    headSha: ciRun.oid,
    headBranch: state.prs.find((pr) => pr.number === ciRun.pr)?.headRefName ?? "",
    event: "pull_request",
    status: ciRun.passed === null ? "in_progress" : "completed",
    conclusion: conclusionOf(ciRun.passed),
    output: ciRun.output,
  }));

  if (sub === "list")
    return {
      stdout: json(runs.map(({ output: _output, ...listed }) => listed)),
      state,
      change: null,
    };

  if (sub === "view")
    return {
      stdout: runs
        .map(
          (ciRun) =>
            `run ${ciRun.databaseId} ${ciRun.headSha.slice(0, 7)} ${ciRun.conclusion}\n${ciRun.output}`,
        )
        .join("\n"),
      state,
      change: null,
    };

  return fail(`unknown command "${sub ?? ""}" for "gh run"`);
}

function fieldPairs(raw: readonly string[]): Map<string, string> {
  return new Map(
    raw.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
}

function apiCommand(state: FakeGitHub, args: readonly string[], context: Context): Outcome {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: false,
    options: {
      method: { type: "string", short: "X" },
      "raw-field": { type: "string", short: "f", multiple: true },
      field: { type: "string", short: "F", multiple: true },
      input: { type: "string" },
      jq: { type: "string", short: "q" },
      header: { type: "string", short: "H", multiple: true },
      paginate: { type: "boolean" },
      silent: { type: "boolean" },
    },
  });

  const pairs = fieldPairs([...stringsOf(values, "raw-field"), ...stringsOf(values, "field")]);
  const input = stringOf(values, "input");
  const fields = requestFields(pairs, input);
  const endpoint = positionals[0] ?? fail("accepts 1 arg(s), received 0");

  if (endpoint === "graphql") return graphql(state, fields, context);

  const method =
    stringOf(values, "method")?.toUpperCase() ??
    (pairs.size > 0 || input !== undefined ? "POST" : "GET");

  return rest(state, method, endpoint, fields, context);
}

export function run(state: FakeGitHub, argv: readonly string[], context: Context): Outcome {
  const [command, sub, ...args] = argv;
  const read = (stdout: string): Outcome => ({ stdout, state, change: null });

  switch (command) {
    case "--version":
    case "version":
      return read("gh version 2.83.0 (2026-09-30)\n");

    case "auth":
      return sub === "status"
        ? read(`github.com\n  ✓ Logged in to github.com account ${state.viewer} (keyring)\n`)
        : fail("gh auth: not available here");

    case "api":
      return apiCommand(
        state,
        [sub ?? "", ...args].filter((arg) => arg !== ""),
        context,
      );

    case "repo":
      return sub === "view"
        ? repoView(state, args)
        : fail(`unknown command "${sub ?? ""}" for "gh repo"`);

    case "pr":
      return prCommand(state, sub, args, context);

    case "run":
      return runCommand(state, sub);

    default:
      return fail(`unknown command "${command ?? ""}" for "gh"`);
  }
}

function jqFilter(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((arg) => arg === "--jq" || arg === "-q");

  if (index !== -1) return argv[index + 1];

  return argv.find((arg) => arg.startsWith("--jq="))?.slice(5);
}

/** One `gh` call: advance the world, apply the command, save, and log, holding the state lock. */
export function call(
  paths: GhPaths,
  tracker: Context["tracker"],
  argv: readonly string[],
  actor = "agent",
) {
  return withLock(paths.state, () => {
    const now = new Date();
    const context: Context = { now, tracker, actor };
    const before = advance(readGitHub(paths.state), now);
    let outcome: Outcome | null = null;
    let failure: GhExit | null = null;

    try {
      outcome = run(before, argv, context);
    } catch (error) {
      if (!(error instanceof GhExit)) throw error;

      failure = error;
    }

    writeGitHub(paths.state, outcome?.state ?? before);

    const exitCode = failure?.code ?? outcome?.exitCode ?? 0;

    const entry: GhLogEntry = {
      at: now.toISOString(),
      argv,
      cwd: process.cwd(),
      exitCode,
      change: outcome?.change ?? null,
      stderr: failure?.stderr ?? "",
    };

    appendFileSync(paths.log, `${JSON.stringify({ ...entry, actor })}\n`);

    return { stdout: outcome?.stdout ?? "", stderr: failure?.stderr ?? "", exitCode };
  });
}

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    console.error(`gh: ${name} is not set`);
    process.exit(2);
  }

  return value;
}

const WATCH_INTERVAL_MS = 5000;

function main() {
  const paths = { state: required("FAKEGH_STATE"), log: required("FAKEGH_LOG") };
  const tracker = { state: required("TRACKER_STATE"), log: required("TRACKER_LOG") };
  const argv = process.argv.slice(2);
  const watching = argv[0] === "pr" && argv[1] === "checks" && argv.includes("--watch");
  let result = call(paths, tracker, argv);

  // `gh pr checks --watch` polls until no check is pending, releasing the lock between polls.
  if (watching) {
    while (result.exitCode === 8) {
      sleep(WATCH_INTERVAL_MS);
      result = call(paths, tracker, argv);
    }
  }

  const filter = jqFilter(argv);

  process.stdout.write(
    filter === undefined || result.stdout === ""
      ? result.stdout
      : execFileSync("jq", ["-r", filter], { input: result.stdout, encoding: "utf8" }),
  );

  if (result.stderr !== "") process.stderr.write(`${result.stderr}\n`);

  process.exitCode = result.exitCode;
}

if (import.meta.main) main();
