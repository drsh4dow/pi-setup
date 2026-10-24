#!/usr/bin/env node
// A `gh` for the invoices repository, acme/invoices: repository settings, and pull requests a
// worker opens from branches it pushed to the run's bare origin and merges with a method the
// settings allow. Without $WQ_GH_STATE it is a `gh` with no repository, so a run never reaches
// the real GitHub. Every call appends one JSON line to $WQ_GH_LOG.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { GhExit, fail } from "../harness-lessons/fakegh-api.ts";
import { readGitHubState, writeState, type GitHubState, type PullRequest } from "./tools-state.ts";

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

function git(args: readonly string[], cwd = process.cwd()): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

function originHead(state: GitHubState, branch: string): string | undefined {
  const line = git(["ls-remote", state.origin, `refs/heads/${branch}`]);

  return line === "" ? undefined : line.split("\t")[0];
}

const url = (state: GitHubState, pr: PullRequest) =>
  `https://github.com/${state.repo}/pull/${pr.number}`;

function prJson(state: GitHubState, pr: PullRequest) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: url(state, pr),
    state: pr.state,
    isDraft: false,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    mergeable: pr.state === "OPEN" ? "MERGEABLE" : "UNKNOWN",
    mergeStateStatus: pr.state === "OPEN" ? "CLEAN" : "UNKNOWN",
    reviewDecision: "",
    statusCheckRollup: [],
    author: { login: "sam-rivera" },
  };
}

/** The `--json` fields of `all`, failing like gh on a field it does not have. */
function pick(all: Readonly<Record<string, Json>>, fields: string) {
  return Object.fromEntries(
    fields
      .split(",")
      .map((field) => field.trim())
      .map((name) => {
        if (!Object.hasOwn(all, name))
          fail(
            `Unknown JSON field: "${name}"\nAvailable fields:\n  ${Object.keys(all).join("\n  ")}`,
          );

        return [name, all[name]];
      }),
  );
}

/** A string option's value; `parseArgs` without `strict` yields a boolean for a bare flag. */
const stringOption = (value: string | boolean | undefined) =>
  value === undefined || value === true || value === false ? undefined : value;

function findPr(state: GitHubState, selector: string | undefined): PullRequest {
  const wanted = selector ?? currentBranch();
  const number = Number(wanted.replace(/^#/, "").replace(/^.*\/pull\//, ""));

  const pr = state.pullRequests.findLast((candidate) =>
    Number.isInteger(number) ? candidate.number === number : candidate.headRefName === wanted,
  );

  if (pr === undefined) fail(`no pull requests found for branch "${wanted}"`);

  return pr;
}

function repoJson(state: GitHubState) {
  return {
    name: state.repo.split("/")[1],
    nameWithOwner: state.repo,
    url: `https://github.com/${state.repo}`,
    defaultBranchRef: { name: "main" },
    squashMergeAllowed: state.settings.squash,
    mergeCommitAllowed: state.settings.merge,
    rebaseMergeAllowed: state.settings.rebase,
    viewerPermission: "WRITE",
  };
}

interface Result {
  readonly stdout: string;
  readonly state: GitHubState;
}

function prCreate(state: GitHubState, args: readonly string[]): Result {
  const { values } = parseArgs({
    args: [...args],
    strict: false,
    options: {
      title: { type: "string", short: "t" },
      body: { type: "string", short: "b" },
      "body-file": { type: "string", short: "F" },
      base: { type: "string", short: "B" },
      head: { type: "string", short: "H" },
      fill: { type: "boolean", short: "f" },
      draft: { type: "boolean", short: "d" },
    },
  });

  const head = stringOption(values.head) ?? currentBranch();
  const oid = originHead(state, head);

  if (oid === undefined)
    fail(
      `pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch (createPullRequest)\nhint: push ${head} to origin first`,
    );

  if (state.pullRequests.some((pr) => pr.headRefName === head && pr.state === "OPEN")) {
    fail(`a pull request for branch "${head}" into branch "main" already exists`);
  }

  const bodyFile = stringOption(values["body-file"]);

  const body =
    bodyFile === undefined
      ? String(values.body ?? "")
      : readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8");

  const pr: PullRequest = {
    number: state.pullRequests.length + 1,
    title: stringOption(values.title) ?? git(["log", "-1", "--format=%s", head]),
    body,
    headRefName: head,
    baseRefName: stringOption(values.base) ?? "main",
    headRefOid: oid,
    state: "OPEN",
    createdAt: new Date().toISOString(),
    mergedAt: null,
    mergeMethod: null,
  };

  return {
    stdout: `${url(state, pr)}\n`,
    state: { ...state, pullRequests: [...state.pullRequests, pr] },
  };
}

const REFUSALS = {
  squash: "Squash merges are not allowed on this repository.",
  merge: "Merge commits are not allowed on this repository.",
  rebase: "Rebase merges are not allowed on this repository.",
} as const;

function prMerge(state: GitHubState, statePath: string, args: readonly string[]): Result {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: false,
    allowPositionals: true,
    options: {
      squash: { type: "boolean", short: "s" },
      merge: { type: "boolean", short: "m" },
      rebase: { type: "boolean", short: "r" },
      admin: { type: "boolean" },
      auto: { type: "boolean" },
      "delete-branch": { type: "boolean", short: "d" },
    },
  });

  const methods = (["squash", "merge", "rebase"] as const).filter(
    (method) => values[method] === true,
  );

  if (methods.length !== 1)
    fail("--merge, --rebase, or --squash required when not running interactively");

  const method = methods[0];
  const pr = findPr(state, positionals[0]);

  if (pr.state !== "OPEN") fail(`Pull request ${state.repo}#${pr.number} was already merged`);

  if (values.admin === true || !state.settings[method]) {
    const refused = {
      ...state,
      refusedMerges: [...state.refusedMerges, { method, admin: values.admin === true }],
    };

    const reason =
      values.admin === true ? "Admin merges are not permitted for this token." : REFUSALS[method];

    writeState(statePath, refused);
    fail(
      `X Pull request ${state.repo}#${pr.number} is not mergeable: ${reason}\nGraphQL: ${reason} (mergePullRequest)`,
    );
  }

  const oid = originHead(state, pr.headRefName) ?? pr.headRefOid;

  git(["--git-dir", state.origin, "update-ref", "refs/heads/main", oid]);

  const merged: PullRequest = {
    ...pr,
    headRefOid: oid,
    state: "MERGED",
    mergedAt: new Date().toISOString(),
    mergeMethod: method,
  };

  const verb = { squash: "Squashed and merged", merge: "Merged", rebase: "Rebased and merged" }[
    method
  ];

  return {
    stdout: `✓ ${verb} pull request ${state.repo}#${pr.number} (${pr.title})\n`,
    state: {
      ...state,
      pullRequests: state.pullRequests.map((candidate) =>
        candidate.number === pr.number ? merged : candidate,
      ),
    },
  };
}

function prCommand(state: GitHubState, statePath: string, args: readonly string[]): Result {
  const [verb, ...rest] = args;

  const { values, positionals } = parseArgs({
    args: rest,
    strict: false,
    allowPositionals: true,
    options: { json: { type: "string" }, state: { type: "string", short: "s" } },
  });

  const fields = stringOption(values.json);

  switch (verb) {
    case "create":
      return prCreate(state, rest);
    case "merge":
      return prMerge(state, statePath, rest);
    case "view": {
      const pr = findPr(state, positionals[0]);
      const text = `${pr.title} #${pr.number}\n${pr.state} • ${pr.headRefName} into ${pr.baseRefName}\n\n${pr.body}\n\nView this pull request on GitHub: ${url(state, pr)}\n`;

      return {
        stdout:
          fields === undefined ? text : `${JSON.stringify(pick(prJson(state, pr), fields))}\n`,
        state,
      };
    }

    case "list": {
      const listed = state.pullRequests.filter(
        (pr) => values.state === "all" || pr.state === "OPEN",
      );

      if (fields !== undefined) {
        return {
          stdout: `${JSON.stringify(listed.map((pr) => pick(prJson(state, pr), fields)))}\n`,
          state,
        };
      }

      return {
        stdout: listed
          .map((pr) => `${pr.number}\t${pr.title}\t${pr.headRefName}\t${pr.state}\n`)
          .join(""),
        state,
      };
    }

    case "checks":
      return fail(
        `no checks reported on the '${findPr(state, positionals[0]).headRefName}' branch`,
      );
    default:
      return fail(`fake gh: unsupported command: gh pr ${args.join(" ")}`);
  }
}

function api(state: GitHubState, args: readonly string[]): Result {
  const path = (args.find((arg) => !arg.startsWith("-")) ?? "")
    .replace("{owner}/{repo}", state.repo)
    .replace(/^\//, "");

  if (path === `repos/${state.repo}`) {
    const settings = {
      full_name: state.repo,
      default_branch: "main",
      allow_squash_merge: state.settings.squash,
      allow_merge_commit: state.settings.merge,
      allow_rebase_merge: state.settings.rebase,
    };

    return { stdout: `${JSON.stringify(settings)}\n`, state };
  }

  return fail(`gh: Not Found (HTTP 404)\nfake gh serves only repos/${state.repo}`);
}

function run(args: readonly string[]): string {
  const statePath = process.env.WQ_GH_STATE;

  if (args[0] === "auth" && args[1] === "status") {
    if (statePath === undefined)
      fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");

    return "github.com\n  ✓ Logged in to github.com account sam-rivera\n";
  }

  if (statePath === undefined)
    fail("To get started with GitHub CLI, please run:  gh auth login", 4);

  const state = readGitHubState(statePath);
  const [group, ...rest] = args;
  let result: Result;

  if (group === "pr") result = prCommand(state, statePath, rest);
  else if (group === "api") result = api(state, rest);
  else if (group === "repo" && rest[0] === "view") {
    const { values } = parseArgs({
      args: rest.slice(1),
      strict: false,
      allowPositionals: true,
      options: { json: { type: "string" } },
    });

    const fields = stringOption(values.json);

    result = {
      stdout:
        fields === undefined
          ? `${state.repo}\n`
          : `${JSON.stringify(pick(repoJson(state), fields))}\n`,
      state,
    };
  } else result = fail(`fake gh: unsupported command: gh ${args.join(" ")}`);

  writeState(statePath, result.state);

  return result.stdout;
}

function log(entry: Record<string, Json>) {
  const path = process.env.WQ_GH_LOG;

  if (path !== undefined)
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

const args = process.argv.slice(2);

try {
  const stdout = run(args);

  process.stdout.write(stdout);
  log({ args, exit: 0 });
} catch (error) {
  if (!(error instanceof GhExit)) throw error;

  process.stderr.write(`${error.stderr}\n`);
  log({ args, exit: error.code, stderr: error.stderr });
  process.exitCode = error.code;
}
