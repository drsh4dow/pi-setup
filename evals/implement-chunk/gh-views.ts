// How the fake GitHub's state reads through `gh`: the JSON fields of `gh pr view --json`, the
// GraphQL pull request the babysit watcher queries, and the REST shapes agents fetch by hand.

import { branchOid, commitsBetween, mergeTree } from "./gh-git.ts";
import {
  BOT,
  ciRunFor,
  type Comment,
  type FakeGitHub,
  type PullRequest,
  type Review,
  type Thread,
} from "./gh-state.ts";
import type { JsonValue } from "./json.ts";

export function json(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const PAGE_INFO = { hasNextPage: false, endCursor: null };

export function repoUrl(state: FakeGitHub): string {
  return `https://github.com/${state.owner}/${state.repo}`;
}

export function prUrl(state: FakeGitHub, pr: PullRequest): string {
  return `${repoUrl(state)}/pull/${pr.number}`;
}

export type CiStatus = "pending" | "passed" | "failed";

const CONCLUSION = {
  pending: null,
  passed: "SUCCESS",
  failed: "FAILURE",
} as const satisfies Record<CiStatus, string | null>;

export function ciStatus(state: FakeGitHub, pr: PullRequest): CiStatus {
  const run = ciRunFor(state, pr);

  if (run === undefined || run.passed === null) return "pending";

  return run.passed ? "passed" : "failed";
}

export function isMergeable(state: FakeGitHub, pr: PullRequest): boolean {
  const base = branchOid(state.bare, pr.baseRefName);

  if (base === null) return false;

  return mergeTree(state.bare, base, pr.headRefOid) !== null;
}

function mergeStateStatus(state: FakeGitHub, pr: PullRequest): string {
  if (pr.state !== "OPEN") return "UNKNOWN";

  if (pr.isDraft) return "DRAFT";

  if (!isMergeable(state, pr)) return "DIRTY";

  return ciStatus(state, pr) === "passed" ? "CLEAN" : "UNSTABLE";
}

export function checkNodes(state: FakeGitHub, pr: PullRequest) {
  const run = ciRunFor(state, pr);
  const status = ciStatus(state, pr);

  return [
    {
      __typename: "CheckRun",
      name: "check",
      status: status === "pending" ? "IN_PROGRESS" : "COMPLETED",
      conclusion: CONCLUSION[status],
      workflowName: "CI",
      detailsUrl: `${repoUrl(state)}/actions/runs/${pr.number}0${pr.heads.length}/job/check`,
      startedAt: run?.requestedAt ?? pr.createdAt,
      completedAt: run?.finishedAt ?? null,
    },
  ];
}

function graphqlComment(state: FakeGitHub, pr: PullRequest, comment: Comment, thread?: Thread) {
  return {
    id: comment.id,
    databaseId: comment.databaseId,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    lastEditedAt: comment.updatedAt === comment.createdAt ? null : comment.updatedAt,
    url: `${prUrl(state, pr)}#${thread ? "discussion_r" : "issuecomment-"}${comment.databaseId}`,
    author: { login: comment.author },
    path: thread?.path ?? null,
    line: thread?.line ?? null,
  };
}

export function graphqlThread(state: FakeGitHub, pr: PullRequest, thread: Thread) {
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: false,
    path: thread.path,
    line: thread.line,
    comments: {
      pageInfo: PAGE_INFO,
      totalCount: thread.comments.length,
      nodes: thread.comments.map((comment) => graphqlComment(state, pr, comment, thread)),
    },
  };
}

function graphqlReview(state: FakeGitHub, pr: PullRequest, review: Review) {
  return {
    id: review.id,
    databaseId: review.databaseId,
    body: review.body,
    state: review.state,
    submittedAt: review.submittedAt,
    updatedAt: review.submittedAt,
    url: `${prUrl(state, pr)}#pullrequestreview-${review.databaseId}`,
    author: { login: review.author },
    commit: { oid: review.commitOid },
  };
}

export function reviewsOf(state: FakeGitHub, pr: PullRequest): Review[] {
  return state.reviews.filter((review) => review.pr === pr.number);
}

export function threadsOf(state: FakeGitHub, pr: PullRequest): Thread[] {
  return state.threads.filter((thread) => thread.pr === pr.number);
}

function commitNodes(state: FakeGitHub, pr: PullRequest) {
  const base = branchOid(state.bare, pr.baseRefName) ?? pr.headRefOid;
  const commits = commitsBetween(state.bare, base, pr.headRefOid);

  const rollupState = { pending: "PENDING", passed: "SUCCESS", failed: "FAILURE" }[
    ciStatus(state, pr)
  ];

  return commits.map((commit) => ({
    commit: {
      oid: commit.oid,
      messageHeadline: commit.headline,
      statusCheckRollup:
        commit.oid === pr.headRefOid
          ? {
              state: rollupState,
              contexts: { pageInfo: PAGE_INFO, totalCount: 1, nodes: checkNodes(state, pr) },
            }
          : null,
    },
  }));
}

/** Every field the babysit queries read, whatever subset a query asks for. */
export function graphqlPullRequest(state: FakeGitHub, pr: PullRequest) {
  const reviews = reviewsOf(state, pr).map((review) => graphqlReview(state, pr, review));
  const commits = commitNodes(state, pr);

  return {
    id: `PR_kwDOTally${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: prUrl(state, pr),
    state: pr.state,
    isDraft: pr.isDraft,
    mergeable: pr.state === "OPEN" && !isMergeable(state, pr) ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: mergeStateStatus(state, pr),
    reviewDecision: null,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    createdAt: pr.createdAt,
    author: { login: pr.author },
    reviews: { pageInfo: PAGE_INFO, totalCount: reviews.length, nodes: reviews },
    latestReviews: { pageInfo: PAGE_INFO, totalCount: reviews.length, nodes: reviews },
    comments: {
      pageInfo: PAGE_INFO,
      totalCount: pr.comments.length,
      nodes: pr.comments.map((comment) => graphqlComment(state, pr, comment)),
    },
    reviewThreads: {
      pageInfo: PAGE_INFO,
      totalCount: threadsOf(state, pr).length,
      nodes: threadsOf(state, pr).map((thread) => graphqlThread(state, pr, thread)),
    },
    commits: { pageInfo: PAGE_INFO, totalCount: commits.length, nodes: commits },
  };
}

/** The fields of `gh pr view --json` and `gh pr list --json`. */
export function prFields(state: FakeGitHub, pr: PullRequest) {
  const graph = graphqlPullRequest(state, pr);

  return {
    id: graph.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: graph.url,
    state: pr.state,
    closed: pr.state !== "OPEN",
    isDraft: pr.isDraft,
    mergeable: graph.mergeable,
    mergeStateStatus: graph.mergeStateStatus,
    reviewDecision: "",
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    createdAt: pr.createdAt,
    updatedAt: pr.heads.at(-1)?.at ?? pr.createdAt,
    author: graph.author,
    mergedBy: pr.mergedBy === null ? null : { login: pr.mergedBy },
    mergeCommit: pr.mergeCommit === null ? null : { oid: pr.mergeCommit },
    isCrossRepository: false,
    labels: [],
    assignees: [],
    reviewRequests: [],
    statusCheckRollup: checkNodes(state, pr),
    reviews: graph.reviews.nodes,
    latestReviews: graph.latestReviews.nodes,
    comments: graph.comments.nodes,
    commits: graph.commits.nodes.map((node) => ({
      oid: node.commit.oid,
      messageHeadline: node.commit.messageHeadline,
    })),
  };
}

export function prText(state: FakeGitHub, pr: PullRequest, withComments: boolean): string {
  const status = ciStatus(state, pr);

  const lines = [
    `${pr.title} #${pr.number}`,
    `${pr.state} • ${pr.author} wants to merge into ${pr.baseRefName} from ${pr.headRefName}`,
    `Checks: ${status} • Mergeable: ${isMergeable(state, pr) ? "yes" : "no (conflicts)"}`,
    "",
    pr.body,
    "",
  ];

  if (withComments) {
    for (const review of reviewsOf(state, pr)) {
      lines.push(
        `${review.author} reviewed (${review.state}) • ${review.submittedAt}`,
        review.body,
        "",
      );
    }

    for (const comment of pr.comments) {
      lines.push(`${comment.author} commented • ${comment.createdAt}`, comment.body, "");
    }
  }

  lines.push(`View this pull request on GitHub: ${prUrl(state, pr)}`);

  return `${lines.join("\n")}\n`;
}

export function restPullRequest(state: FakeGitHub, pr: PullRequest) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === "OPEN" ? "open" : "closed",
    draft: pr.isDraft,
    merged: pr.state === "MERGED",
    mergeable: pr.state === "OPEN" ? isMergeable(state, pr) : null,
    mergeable_state: mergeStateStatus(state, pr).toLowerCase(),
    html_url: prUrl(state, pr),
    user: { login: pr.author },
    head: { ref: pr.headRefName, sha: pr.headRefOid },
    base: { ref: pr.baseRefName },
    created_at: pr.createdAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommit,
  };
}

export function restReview(review: Review) {
  return {
    id: review.databaseId,
    node_id: review.id,
    user: { login: review.author, type: review.author === BOT ? "Bot" : "User" },
    state: review.state,
    body: review.body,
    submitted_at: review.submittedAt,
    commit_id: review.commitOid,
  };
}

export function restThreadComment(
  state: FakeGitHub,
  pr: PullRequest,
  thread: Thread,
  comment: Comment,
) {
  const first = thread.comments[0];

  return {
    id: comment.databaseId,
    node_id: comment.id,
    in_reply_to_id: comment === first ? null : first.databaseId,
    body: comment.body,
    user: { login: comment.author, type: comment.author === BOT ? "Bot" : "User" },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    path: thread.path,
    line: thread.line,
    commit_id: pr.headRefOid,
    html_url: `${prUrl(state, pr)}#discussion_r${comment.databaseId}`,
  };
}

export function restIssueComment(comment: Comment) {
  return {
    id: comment.databaseId,
    node_id: comment.id,
    body: comment.body,
    user: { login: comment.author },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}
