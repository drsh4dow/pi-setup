// `gh api`: the GraphQL queries and mutations the babysit watcher and agents send, and the REST
// endpoints agents call by hand, answered from the fake GitHub's state.

import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { diff } from "./gh-git.ts";
import {
  commentOnPr,
  dismissReview,
  editPr,
  fail,
  mergePr,
  readyPr,
  replyToThread,
  requirePr,
  resolveThread,
  reviewPr,
  type Context,
  type MergeMethod,
  type Outcome,
} from "./gh-ops.ts";
import type { FakeGitHub } from "./gh-state.ts";
import {
  ciStatus,
  graphqlPullRequest,
  graphqlThread,
  json,
  restIssueComment,
  restPullRequest,
  restReview,
  restThreadComment,
  reviewsOf,
  threadsOf,
} from "./gh-views.ts";
import type { JsonValue } from "./json.ts";

const isString = Schema.is(Schema.String);

const decodeInput = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const REST_CONCLUSION = { pending: null, passed: "success", failed: "failure" } as const;

function ciStatusOf(passed: boolean | null): keyof typeof REST_CONCLUSION {
  if (passed === null) return "pending";

  return passed ? "passed" : "failed";
}

/** The request's fields: `-f`/`-F` pairs, or the JSON object `--input` names. */
export function requestFields(
  pairs: ReadonlyMap<string, string>,
  input: string | undefined,
): ReadonlyMap<string, string> {
  if (input === undefined) return pairs;

  const parsed = decodeInput(readFileSync(input === "-" ? 0 : input, "utf8"));

  return new Map(
    Object.entries(parsed).map(([key, value]) => [
      key,
      isString(value) ? value : JSON.stringify(value),
    ]),
  );
}

/** The value of a variable or of an inline argument named `name` in a GraphQL request. */
function graphqlValue(query: string, variables: ReadonlyMap<string, string>, name: string) {
  const inline = new RegExp(
    `\\b${name}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|(\\d+)|([A-Z_]+)\\b)`,
  ).exec(query);

  if (inline !== null) return inline[1] ?? inline[2] ?? inline[3];

  const variable = new RegExp(`\\b${name}\\s*:\\s*\\$(\\w+)`).exec(query)?.[1];

  return variable === undefined ? undefined : variables.get(variable);
}

function prNumberIn(query: string, variables: ReadonlyMap<string, string>): number | undefined {
  const raw =
    graphqlValue(query, variables, "number") ?? variables.get("pr") ?? variables.get("number");

  return raw === undefined ? undefined : Number(raw);
}

function threadNode(state: FakeGitHub, id: string) {
  const thread = state.threads.find((candidate) => candidate.id === id);

  if (thread === undefined) return null;

  return graphqlThread(state, requirePr(state, thread.pr), thread);
}

function graphqlQuery(
  state: FakeGitHub,
  query: string,
  variables: ReadonlyMap<string, string>,
): Outcome {
  const number = prNumberIn(query, variables);

  const nodeId =
    variables.get("thread") ?? variables.get("id") ?? graphqlValue(query, variables, "id");

  const pullRequest =
    number === undefined ? null : graphqlPullRequest(state, requirePr(state, number));

  const pullRequests = state.prs
    .filter((pr) => pr.state === "OPEN")
    .map((pr) => graphqlPullRequest(state, pr));

  const data = {
    viewer: { login: state.viewer },
    repository: {
      name: state.repo,
      nameWithOwner: `${state.owner}/${state.repo}`,
      owner: { login: state.owner },
      defaultBranchRef: { name: state.defaultBranch },
      mergeCommitAllowed: state.settings.mergeCommitAllowed,
      squashMergeAllowed: state.settings.squashMergeAllowed,
      rebaseMergeAllowed: state.settings.rebaseMergeAllowed,
      pullRequest,
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        totalCount: pullRequests.length,
        nodes: pullRequests,
      },
    },
    node: nodeId === undefined ? null : threadNode(state, nodeId),
  };

  return { stdout: json({ data }), state, change: null };
}

function graphqlMutation(
  state: FakeGitHub,
  query: string,
  variables: ReadonlyMap<string, string>,
  context: Context,
): Outcome {
  const value = (name: string) => graphqlValue(query, variables, name);
  const threadId = value("threadId") ?? value("pullRequestReviewThreadId");

  if (/\bunresolveReviewThread\b/.test(query)) {
    return withData(
      resolveThread(state, threadId ?? fail("unresolveReviewThread needs threadId"), false),
      { unresolveReviewThread: { thread: { id: threadId ?? "", isResolved: false } } },
    );
  }

  if (/\bresolveReviewThread\b/.test(query)) {
    return withData(
      resolveThread(state, threadId ?? fail("resolveReviewThread needs threadId"), true),
      { resolveReviewThread: { thread: { id: threadId ?? "", isResolved: true } } },
    );
  }

  if (/\baddPullRequestReviewThreadReply\b/.test(query)) {
    const reply = replyToThread(
      state,
      threadId ?? fail("the reply needs a thread"),
      value("body") ?? fail("the reply needs a body"),
      context,
    );

    return withData(reply.outcome, {
      addPullRequestReviewThreadReply: {
        comment: { id: reply.comment.id, body: reply.comment.body },
      },
    });
  }

  if (/\bdismissPullRequestReview\b/.test(query)) {
    const id =
      value("pullRequestReviewId") ?? fail("dismissPullRequestReview needs pullRequestReviewId");

    return withData(dismissReview(state, id, value("message") ?? ""), {
      dismissPullRequestReview: { pullRequestReview: { id, state: "DISMISSED" } },
    });
  }

  const pr = () =>
    state.prs.find((candidate) => `PR_kwDOTally${candidate.number}` === value("pullRequestId")) ??
    fail("Could not resolve the pull request id");

  if (/\bmarkPullRequestReadyForReview\b/.test(query))
    return withData(readyPr(state, pr().number, false), {
      markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
    });

  if (/\bmergePullRequest\b/.test(query)) {
    const method = (value("mergeMethod") ?? "MERGE").toLowerCase();

    return withData(
      mergePr(state, pr().number, { method: mergeMethodOf(method), deleteBranch: false }, context),
      { mergePullRequest: { pullRequest: { state: "MERGED" } } },
    );
  }

  return fail("GraphQL: this mutation is not available to this token (FORBIDDEN)");
}

function withData(outcome: Outcome, data: JsonValue): Outcome {
  return { ...outcome, stdout: json({ data }) };
}

export function mergeMethodOf(raw: string): MergeMethod {
  if (raw === "merge" || raw === "squash" || raw === "rebase") return raw;

  return fail(`unknown merge method ${raw}`);
}

export function graphql(
  state: FakeGitHub,
  fields: ReadonlyMap<string, string>,
  context: Context,
): Outcome {
  const query = fields.get("query") ?? fail("GraphQL: a query is required");

  if (/^\s*mutation\b/.test(query) || /\bmutation\s*[\w({]/.test(query))
    return graphqlMutation(state, query, fields, context);

  return graphqlQuery(state, query, fields);
}

function bodyField(fields: ReadonlyMap<string, string>): string {
  return fields.get("body") ?? fail("Validation Failed: body is required (HTTP 422)");
}

function restPull(
  state: FakeGitHub,
  method: string,
  number: number,
  subpath: string,
  fields: ReadonlyMap<string, string>,
  context: Context,
): Outcome {
  const pr = requirePr(state, number);
  const read = (value: JsonValue): Outcome => ({ stdout: json(value), state, change: null });

  if (subpath === "" && method === "GET") return read(restPullRequest(state, pr));

  if (subpath === "" && method === "PATCH") {
    const edited = editPr(state, number, {
      title: fields.get("title"),
      body: fields.get("body"),
      base: fields.get("base"),
    });

    return {
      ...edited,
      stdout: json(restPullRequest(edited.state, requirePr(edited.state, number))),
    };
  }

  if (subpath === "/merge" && method === "PUT") {
    const merged = mergePr(
      state,
      number,
      { method: mergeMethodOf(fields.get("merge_method") ?? "merge"), deleteBranch: false },
      context,
    );

    return {
      ...merged,
      stdout: json({ merged: true, message: "Pull Request successfully merged" }),
    };
  }

  if (subpath === "/reviews" && method === "GET") return read(reviewsOf(state, pr).map(restReview));

  if (subpath === "/reviews" && method === "POST") {
    const event =
      { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" }[fields.get("event") ?? ""] ??
      "COMMENTED";

    return reviewPr(
      state,
      number,
      {
        event: event === "APPROVED" || event === "CHANGES_REQUESTED" ? event : "COMMENTED",
        body: fields.get("body") ?? "",
      },
      context,
    );
  }

  const dismissal = /^\/reviews\/(\d+)\/dismissals$/.exec(subpath);

  if (dismissal !== null && method === "PUT")
    return dismissReview(state, Number(dismissal[1]), fields.get("message") ?? "");

  if (subpath === "/comments" && method === "GET") {
    return read(
      threadsOf(state, pr).flatMap((thread) =>
        thread.comments.map((comment) => restThreadComment(state, pr, thread, comment)),
      ),
    );
  }

  const replies = /^\/comments\/(\d+)\/replies$/.exec(subpath);

  if (replies !== null && method === "POST") {
    const thread =
      threadsOf(state, pr).find((candidate) =>
        candidate.comments.some((comment) => comment.databaseId === Number(replies[1])),
      ) ?? fail("Not Found (HTTP 404)");

    const reply = replyToThread(state, thread.id, bodyField(fields), context);

    return {
      ...reply.outcome,
      stdout: json(restThreadComment(reply.outcome.state, pr, reply.thread, reply.comment)),
    };
  }

  if (subpath === "/files" && method === "GET") {
    return read(
      diff(state.bare, pr.baseRefName, pr.headRefOid, true)
        .split("\n")
        .filter((line) => line !== "")
        .map((filename) => ({ filename })),
    );
  }

  if (subpath === "/commits" && method === "GET")
    return read(
      graphqlPullRequest(state, pr).commits.nodes.map((node) => ({
        sha: node.commit.oid,
        commit: { message: node.commit.messageHeadline },
      })),
    );

  if (subpath === "/requested_reviewers") return read({ users: [], teams: [] });

  return fail(`gh: Not Found (HTTP 404) ${method} pulls/${number}${subpath}`);
}

function restRepo(state: FakeGitHub) {
  return {
    name: state.repo,
    full_name: `${state.owner}/${state.repo}`,
    default_branch: state.defaultBranch,
    allow_merge_commit: state.settings.mergeCommitAllowed,
    allow_squash_merge: state.settings.squashMergeAllowed,
    allow_rebase_merge: state.settings.rebaseMergeAllowed,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    html_url: `https://github.com/${state.owner}/${state.repo}`,
  };
}

export function rest(
  state: FakeGitHub,
  method: string,
  endpoint: string,
  fields: ReadonlyMap<string, string>,
  context: Context,
): Outcome {
  const repo = `repos/${state.owner}/${state.repo}`;

  const [rawPath, query = ""] = endpoint
    .replace(/^\//, "")
    .replaceAll("{owner}", state.owner)
    .replaceAll("{repo}", state.repo)
    .split("?");

  const path = rawPath.replace(/\/$/, "");
  const search = new URLSearchParams(query);
  const read = (value: JsonValue): Outcome => ({ stdout: json(value), state, change: null });

  if (path === "user") return read({ login: state.viewer, type: "User" });

  if (path.startsWith("repos/") && !path.startsWith(repo)) fail("gh: Not Found (HTTP 404)");

  if (path === repo) return read(restRepo(state));

  if (path === `${repo}/pulls` && method === "GET") {
    const wanted = search.get("state") ?? "open";

    return read(
      state.prs
        .filter((pr) => wanted === "all" || (wanted === "open") === (pr.state === "OPEN"))
        .filter((pr) => !search.has("base") || pr.baseRefName === search.get("base"))
        .filter(
          (pr) =>
            !search.has("head") ||
            `${state.owner}:${pr.headRefName}` === search.get("head") ||
            pr.headRefName === search.get("head"),
        )
        .map((pr) => restPullRequest(state, pr)),
    );
  }

  const pull = new RegExp(`^${repo}/pulls/(\\d+)(/.*)?$`).exec(path);

  if (pull !== null)
    return restPull(state, method, Number(pull[1]), pull[2] ?? "", fields, context);

  const issueComments = new RegExp(`^${repo}/issues/(\\d+)/comments$`).exec(path);

  if (issueComments !== null) {
    const number = Number(issueComments[1]);

    if (method === "GET") return read(requirePr(state, number).comments.map(restIssueComment));

    const { comment, outcome } = commentOnPr(state, number, bodyField(fields), context);

    return { ...outcome, stdout: json(restIssueComment(comment)) };
  }

  const threadComment = new RegExp(`^${repo}/pulls/comments/(\\d+)$`).exec(path);

  if (threadComment !== null) {
    const thread =
      state.threads.find((candidate) =>
        candidate.comments.some((comment) => comment.databaseId === Number(threadComment[1])),
      ) ?? fail("Not Found (HTTP 404)");

    const comment =
      thread.comments.find((candidate) => candidate.databaseId === Number(threadComment[1])) ??
      fail("Not Found (HTTP 404)");

    return read(restThreadComment(state, requirePr(state, thread.pr), thread, comment));
  }

  const commitChecks = new RegExp(`^${repo}/commits/([^/]+)/(check-runs|status)$`).exec(path);

  if (commitChecks !== null) {
    const pr = state.prs.findLast(
      (candidate) =>
        candidate.headRefOid.startsWith(commitChecks[1]) ||
        candidate.headRefName === commitChecks[1],
    );

    const status = pr === undefined ? "pending" : ciStatus(state, pr);

    if (commitChecks[2] === "status")
      return read({
        state: { pending: "pending", passed: "success", failed: "failure" }[status],
        statuses: [],
      });

    return read({
      total_count: pr === undefined ? 0 : 1,
      check_runs:
        pr === undefined
          ? []
          : [
              {
                name: "check",
                status: status === "pending" ? "in_progress" : "completed",
                conclusion: REST_CONCLUSION[status],
              },
            ],
    });
  }

  if (path === `${repo}/actions/runs` || path === `${repo}/actions/workflows`) {
    return read({
      total_count: state.ci.length,
      workflow_runs: state.ci.map((ciRun, index) => ({
        id: index + 1,
        name: "CI",
        head_sha: ciRun.oid,
        status: ciRun.passed === null ? "in_progress" : "completed",
        conclusion: REST_CONCLUSION[ciStatusOf(ciRun.passed)],
      })),
    });
  }

  if (new RegExp(`^${repo}/branches/[^/]+/protection`).test(path))
    fail("gh: Branch not protected (HTTP 404)");

  return fail(`gh: Not Found (HTTP 404) ${method} ${path}`);
}
