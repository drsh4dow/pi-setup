#!/usr/bin/env node
// A `gh` for one pull request, so the babysit flow runs without GitHub. It answers the queries
// the babysit watcher makes (`gh pr view`, `gh pr checks`, `gh pr list`, and its GraphQL reads)
// and the common ones an agent makes by hand, from the state in $FAKEGH_STATE. Every call
// appends one JSON line to $FAKEGH_LOG, with the change it made on GitHub, if any.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { Option, Schema } from "effect";
import {
  GhExit,
  checkNodes,
  fail,
  graphql,
  graphqlPullRequest,
  json,
  nextComment,
  rest,
  urlOf,
  type JsonValue,
  type Output,
} from "./fakegh-api.ts";
import { FakeGitHub, type GitHubChange, type LogEntry } from "./fakegh-state.ts";

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(FakeGitHub));

const PrOptions = Schema.Struct({
  json: Schema.optional(Schema.String),
  comments: Schema.optional(Schema.Boolean),
  body: Schema.optional(Schema.String),
  "body-file": Schema.optional(Schema.String),
  approve: Schema.optional(Schema.Boolean),
});

const ApiOptions = Schema.Struct({
  method: Schema.optional(Schema.String),
  "raw-field": Schema.optional(Schema.Array(Schema.String)),
  field: Schema.optional(Schema.Array(Schema.String)),
  input: Schema.optional(Schema.String),
});

const decodePrOptions = Schema.decodeUnknownOption(PrOptions);

const decodeApiOptions = Schema.decodeUnknownOption(ApiOptions);

function prFields(state: FakeGitHub) {
  const pr = graphqlPullRequest(state);

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergedAt: pr.mergedAt,
    author: pr.author,
    createdAt: state.pr.createdAt,
    closed: state.pr.state !== "OPEN",
    labels: [],
    assignees: [],
    reviewRequests: [],
    statusCheckRollup: checkNodes(state),
    reviews: pr.reviews.nodes,
    latestReviews: pr.latestReviews.nodes,
    comments: pr.comments.nodes,
    commits: pr.commits.nodes.map((node) => ({
      oid: node.commit.oid,
      messageHeadline: node.commit.messageHeadline,
    })),
  };
}

/** The requested `--json` fields of an object, failing as gh does on an unknown one. */
function pick(all: Readonly<Record<string, JsonValue>>, fields: string) {
  const wanted = fields.split(",").map((name) => name.trim());
  const unknownField = wanted.find((name) => !Object.hasOwn(all, name));

  if (unknownField !== undefined) {
    fail(
      `Unknown JSON field: "${unknownField}"\nAvailable fields:\n  ${Object.keys(all).join("\n  ")}`,
    );
  }

  return Object.fromEntries(Object.entries(all).filter(([name]) => wanted.includes(name)));
}

function prText(state: FakeGitHub, withComments: boolean): string {
  const { pr } = state;

  const lines = [
    `${pr.title} #${pr.number}`,
    `${pr.state === "OPEN" ? "Open" : pr.state} • ${pr.author} wants to merge 2 commits into ${pr.baseRefName} from ${pr.headRefName}`,
    "+9 -3 • ✓ Checks passing",
    "Reviewers: priya-k (Approved), coderabbitai (Commented)",
    "",
    pr.body,
    "",
  ];

  if (withComments) {
    for (const comment of state.comments)
      lines.push(`${comment.author} commented • ${comment.createdAt}`, comment.body, "");
  }

  lines.push(`View this pull request on GitHub: ${urlOf(state)}`);

  return `${lines.join("\n")}\n`;
}

function checksText(state: FakeGitHub): string {
  const rows = state.checks.map(
    (check) => `✓  ${check.workflow}/${check.name}    12s  ${checkNodes(state)[0].detailsUrl}`,
  );

  return `All checks were successful\n0 cancelled, 0 failing, ${state.checks.length} successful, 0 skipped, and 0 pending checks\n\n${rows.join("\n")}\n`;
}

function prCommand(
  state: FakeGitHub,
  sub: string | undefined,
  values: typeof PrOptions.Type,
): Output {
  const read = (stdout: string): Output => ({ stdout, change: null, state });
  const fields = values.json;

  switch (sub) {
    case "view":
      return read(
        fields === undefined
          ? prText(state, values.comments === true)
          : json(pick(prFields(state), fields)),
      );

    case "list":
      return read(
        fields === undefined
          ? `#${state.pr.number}\t${state.pr.title}\t${state.pr.headRefName}\tOPEN\n`
          : json(state.pr.state === "OPEN" ? [pick(prFields(state), fields)] : []),
      );

    case "checks": {
      const checks = state.checks.map((check) => ({
        name: check.name,
        state: "SUCCESS",
        bucket: "pass",
        description: "",
        link: checkNodes(state)[0].detailsUrl,
        workflow: check.workflow,
        event: "pull_request",
        startedAt: state.pr.createdAt,
        completedAt: state.pr.createdAt,
      }));

      return read(
        fields === undefined ? checksText(state) : json(checks.map((check) => pick(check, fields))),
      );
    }

    case "status":
      return read(
        `Current branch\n  #${state.pr.number}  ${state.pr.title} [${state.pr.headRefName}]\n    - Checks passing - Approved\n`,
      );

    case "diff":
      return read(
        execFileSync("git", ["diff", `${state.pr.baseRefName}...${state.pr.headRefName}`], {
          encoding: "utf8",
        }),
      );

    case "comment": {
      const body =
        values.body ??
        readFileSync(
          values["body-file"] ?? fail("gh pr comment: --body or --body-file is required"),
          "utf8",
        );

      const comment = nextComment(state, body);

      return {
        stdout: `${urlOf(state)}#issuecomment-${comment.databaseId}\n`,
        change: { kind: "pr-comment", body },
        state: {
          ...state,
          comments: [...state.comments, comment],
          nextDatabaseId: state.nextDatabaseId + 1,
        },
      };
    }

    case "review":
      return {
        stdout: `✓ Reviewed pull request ${state.owner}/${state.repo}#${state.pr.number}\n`,
        change: {
          kind: "review",
          state: values.approve === true ? "APPROVED" : "COMMENTED",
          body: values.body ?? "",
        },
        state,
      };

    case "merge":
      return {
        stdout: `✓ Merged pull request ${state.owner}/${state.repo}#${state.pr.number} (${state.pr.title})\n`,
        change: { kind: "merge" },
        state: {
          ...state,
          pr: { ...state.pr, state: "MERGED", mergedAt: new Date().toISOString() },
        },
      };

    case undefined:
    default:
      return fail(`unknown command "${sub}" for "gh pr"`);
  }
}

/** `-f key=value` and `-F key=value` pairs, in order. */
function fieldPairs(raw: readonly string[]): Map<string, string> {
  return new Map(
    raw.map((pair) => {
      const split = pair.indexOf("=");

      return [pair.slice(0, split), pair.slice(split + 1)];
    }),
  );
}

function apiCommand(state: FakeGitHub, args: readonly string[]): Output {
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

  const flags = Option.getOrElse(decodeApiOptions(values), () =>
    fail('invalid flags for "gh api"'),
  );

  const fields = fieldPairs([...(flags["raw-field"] ?? []), ...(flags.field ?? [])]);
  const endpoint = positionals[0] ?? fail("accepts 1 arg(s), received 0");
  const { input } = flags;

  if (endpoint === "graphql") {
    const query = fields.get("query") ?? fail("GraphQL: a query is required");

    return graphql(state, query, fields);
  }

  const hasBody = fields.size > 0 || input !== undefined;

  const method = flags.method?.toUpperCase() ?? (hasBody ? "POST" : "GET");

  return rest(state, method, endpoint, fields, input);
}

function run(state: FakeGitHub, argv: readonly string[]): Output {
  const [command, sub, ...args] = argv;
  const read = (stdout: string): Output => ({ stdout, change: null, state });

  switch (command) {
    case "--version":
    case "version":
      return read("gh version 2.83.0 (2026-09-30)\n");

    case "auth":
      if (sub === "status")
        return read(`github.com\n  ✓ Logged in to github.com account ${state.viewer} (keyring)\n`);

      return fail("gh auth: not available here");

    case "api":
      return apiCommand(
        state,
        [sub ?? "", ...args].filter((arg) => arg !== ""),
      );

    case "repo":
      return read(
        json({
          name: state.repo,
          owner: { login: state.owner },
          nameWithOwner: `${state.owner}/${state.repo}`,
          url: `https://github.com/${state.owner}/${state.repo}`,
          defaultBranchRef: { name: "main" },
        }),
      );

    case "pr": {
      const { values } = parseArgs({
        args,
        allowPositionals: true,
        strict: false,
        options: {
          json: { type: "string" },
          jq: { type: "string", short: "q" },
          repo: { type: "string", short: "R" },
          comments: { type: "boolean" },
          body: { type: "string", short: "b" },
          "body-file": { type: "string", short: "F" },
          approve: { type: "boolean" },
        },
      });

      return prCommand(
        state,
        sub,
        Option.getOrElse(decodePrOptions(values), () => fail(`invalid flags for "gh pr ${sub}"`)),
      );
    }

    default:
      return fail(`unknown command "${command}" for "gh"`);
  }
}

function jqFilter(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((arg) => arg === "--jq" || arg === "-q");

  if (index !== -1) return argv[index + 1];

  return argv.find((arg) => arg.startsWith("--jq="))?.slice(5);
}

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    console.error(`gh: ${name} is not set`);
    process.exit(2);
  }

  return value;
}

/** Holds the state lock until this process exits, so parallel calls apply one at a time. */
function lockState(statePath: string) {
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + 10_000;

  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;

      if (Date.now() > deadline) throw new Error(`${lock} held for 10s`, { cause: error });

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  process.on("exit", () => rmdirSync(lock));
}

function main() {
  const statePath = required("FAKEGH_STATE");
  const logPath = required("FAKEGH_LOG");
  const argv = process.argv.slice(2);

  lockState(statePath);

  const state = decodeState(readFileSync(statePath, "utf8"));
  let change: GitHubChange | null = null;

  try {
    const output = run(state, argv);

    change = output.change;

    if (output.state !== state) {
      writeFileSync(`${statePath}.tmp`, json(output.state));
      renameSync(`${statePath}.tmp`, statePath);
    }

    const filter = jqFilter(argv);

    process.stdout.write(
      filter === undefined
        ? output.stdout
        : execFileSync("jq", ["-r", filter], { input: output.stdout, encoding: "utf8" }),
    );
  } catch (error) {
    if (!(error instanceof GhExit)) throw error;

    process.stderr.write(`${error.stderr}\n`);
    process.exitCode = error.code;
  } finally {
    const entry: LogEntry = { at: new Date().toISOString(), argv, change };

    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }
}

if (import.meta.main) main();
