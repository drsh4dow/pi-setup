// PRs #51, #52, and #53 of acme/gift-registry as the catchup story's live state has them, and
// the JSON GitHub would give for them. Branch heads, diffs, and commits come from the run's
// repository in $CATCHUP_REPO, which setup/catchup.sh built.

import { spawnSync } from "node:child_process";
import type { JsonValue } from "./fakegh-api.ts";

export const REPO = "acme/gift-registry";

export const VIEWER = "sam-rivera";

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly description: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface Pr {
  readonly number: number;
  readonly title: string;
  readonly branch: string;
  readonly body: string;
  readonly createdAt: string;
  readonly checks: readonly Check[];
  /** Who approved the PR, and when; none reviewed it otherwise. */
  readonly approval: { readonly author: string; readonly body: string; readonly at: string } | null;
}

const at = (time: string) => `2026-10-24T${time}Z`;

const check = (name: string, description: string, start: string, end: string, passed = true) => ({
  name,
  passed,
  description,
  startedAt: at(start),
  completedAt: at(end),
});

export const PRS: readonly Pr[] = [
  {
    number: 51,
    title: "Fix split gifts losing a cent",
    branch: "fix-split-cent",
    body: "When three guests split a $100 gift, the registry collected $99.99 and showed the gift as 1 cent short. Shares now add up to the price: the first guest to pay takes the leftover cent.\n\nScreenshots of the split-gift page before and after are in the chat.",
    createdAt: at("14:28:10"),
    checks: [
      check("test", "12 passed, 1 skipped", "14:28:20", "14:29:01"),
      check("lint", "", "14:28:20", "14:28:32"),
    ],
    approval: {
      author: "priya-k",
      body: "Looks right. Thanks for the screenshots.",
      at: at("15:21:44"),
    },
  },
  {
    number: 52,
    title: "Show 50 gifts per registry page",
    branch: "page-size-50",
    body: "Registry pages show 50 gifts instead of 20.",
    createdAt: at("14:50:02"),
    checks: [
      check("test", "11 passed, 1 skipped", "14:50:12", "14:50:49"),
      check("lint", "", "14:50:12", "14:50:23"),
    ],
    approval: null,
  },
  {
    number: 53,
    title: "Add an index on gifts.registry_id",
    branch: "search-index",
    body: "Registry search scans the whole gifts table because gifts.registry_id has no index. This migration adds one.\n\nSeed database, p95 search time: 840 ms before, 35 ms after.\n\nBuilding the index on production locks the gifts table for about 4 minutes (measured on a production-size copy). Guests cannot buy gifts while it builds.",
    createdAt: at("15:02:37"),
    checks: [
      check("test", "11 passed, 1 skipped", "15:02:47", "15:03:30"),
      check(
        "lint",
        "migrations/0042_gifts_registry_id.sql: missing trailing newline",
        "15:02:47",
        "15:03:01",
        false,
      ),
    ],
    approval: null,
  },
];

export const urlOf = (pr: Pr) => `https://github.com/${REPO}/pull/${pr.number}`;

export const failing = (pr: Pr) => pr.checks.filter((one) => !one.passed);

/** git in the run's repository; empty when it fails or no repository is set. */
export function repoGit(args: readonly string[]): string {
  const repo = process.env.CATCHUP_REPO;

  if (repo === undefined) return "";

  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });

  return result.status === 0 ? result.stdout : "";
}

export const headOf = (pr: Pr) => repoGit(["rev-parse", `refs/heads/${pr.branch}`]).trim();

export function changedFiles(pr: Pr) {
  return repoGit(["diff", "--numstat", `main...${pr.branch}`])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [additions, deletions, path] = line.split("\t");

      return { path, additions: Number(additions), deletions: Number(deletions) };
    });
}

function commitsOf(pr: Pr) {
  return repoGit(["log", "--reverse", "--format=%H%x09%s%x09%aI", `main..${pr.branch}`])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [oid, messageHeadline, committedDate] = line.split("\t");

      return { oid, messageHeadline, committedDate, authors: [{ login: VIEWER }] };
    });
}

export const detailsUrl = (pr: Pr, index: number) =>
  `https://github.com/${REPO}/actions/runs/${18_410_000 + pr.number * 10}/job/${52_000_000 + pr.number * 10 + index}`;

/** Every field `gh pr view --json` and `gh pr list --json` serve. */
export function prFields(pr: Pr) {
  const files = changedFiles(pr);

  const reviews =
    pr.approval === null
      ? []
      : [
          {
            author: { login: pr.approval.author },
            state: "APPROVED",
            body: pr.approval.body,
            submittedAt: pr.approval.at,
          },
        ];

  const fields = {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: urlOf(pr),
    state: "OPEN",
    isDraft: false,
    author: { login: VIEWER },
    baseRefName: "main",
    headRefName: pr.branch,
    headRefOid: headOf(pr),
    createdAt: pr.createdAt,
    updatedAt: pr.approval?.at ?? pr.checks.at(-1)?.completedAt ?? pr.createdAt,
    mergeable: "MERGEABLE",
    mergeStateStatus: failing(pr).length > 0 ? "UNSTABLE" : "CLEAN",
    reviewDecision: pr.approval === null ? "" : "APPROVED",
    reviews,
    latestReviews: reviews,
    reviewRequests: [],
    statusCheckRollup: pr.checks.map((one, index) => ({
      __typename: "CheckRun",
      name: one.name,
      workflowName: "CI",
      status: "COMPLETED",
      conclusion: one.passed ? "SUCCESS" : "FAILURE",
      startedAt: one.startedAt,
      completedAt: one.completedAt,
      detailsUrl: detailsUrl(pr, index),
    })),
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: files.length,
    files,
    commits: commitsOf(pr),
    comments: [],
    labels: [],
    assignees: [],
    milestone: null,
    closed: false,
    mergedAt: null,
  } satisfies Record<string, JsonValue>;

  return fields;
}

/** Every field `gh pr checks --json` serves, one record per check. */
export function checkFields(pr: Pr) {
  return pr.checks.map(
    (one, index) =>
      ({
        name: one.name,
        state: one.passed ? "SUCCESS" : "FAILURE",
        bucket: one.passed ? "pass" : "fail",
        description: one.description,
        link: detailsUrl(pr, index),
        workflow: "CI",
        event: "pull_request",
        startedAt: one.startedAt,
        completedAt: one.completedAt,
      }) satisfies Record<string, JsonValue>,
  );
}

export const REPO_FIELDS = {
  name: "gift-registry",
  nameWithOwner: REPO,
  owner: { login: "acme" },
  url: `https://github.com/${REPO}`,
  description: "Wedding and baby gift registries",
  defaultBranchRef: { name: "main" },
  isPrivate: true,
  viewerPermission: "WRITE",
} satisfies Record<string, JsonValue>;

function restPr(pr: Pr) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: "open",
    html_url: urlOf(pr),
    user: { login: VIEWER },
    head: { ref: pr.branch, sha: headOf(pr) },
    base: { ref: "main" },
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: failing(pr).length > 0 ? "unstable" : "clean",
    created_at: pr.createdAt,
  } satisfies JsonValue;
}

function checkRuns(pr: Pr) {
  return {
    total_count: pr.checks.length,
    check_runs: pr.checks.map((one, index) => ({
      name: one.name,
      status: "completed",
      conclusion: one.passed ? "success" : "failure",
      html_url: detailsUrl(pr, index),
      output: { title: one.description, summary: one.description },
    })),
  } satisfies JsonValue;
}

export interface RestReply {
  readonly body: JsonValue;
  readonly prs: readonly number[];
}

/**
 * A REST GET below repos/acme/gift-registry: the repository, its pulls, one pull, or a commit's
 * check runs. Anything else is undefined, a 404.
 */
export function restGet(path: string): RestReply | undefined {
  const below = path.replace(/^\/?repos\/acme\/gift-registry\/?/, "").replace(/\?.*$/, "");

  if (below === "") return { body: REPO_FIELDS, prs: [] };

  if (below === "pulls") {
    return { body: PRS.toReversed().map(restPr), prs: PRS.map((pr) => pr.number) };
  }

  const pull = /^(?:pulls|issues)\/(\d+)$/.exec(below);
  const pr = PRS.find((candidate) => String(candidate.number) === pull?.[1]);

  if (pr !== undefined) return { body: restPr(pr), prs: [pr.number] };

  const commit = /^commits\/([^/]+)\/check-runs$/.exec(below)?.[1];

  const byHead = PRS.find(
    (candidate) => commit !== undefined && [candidate.branch, headOf(candidate)].includes(commit),
  );

  if (byHead !== undefined) return { body: checkRuns(byHead), prs: [byHead.number] };

  return undefined;
}
