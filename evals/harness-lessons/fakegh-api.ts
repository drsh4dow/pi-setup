// The GitHub the fake `gh` serves: one pull request's GraphQL and REST answers, and the
// mutations an agent or the babysit watcher makes on it, computed from the state alone.

import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  type Comment,
  type FakeGitHub,
  type GitHubChange,
  type Review,
  type Thread,
} from "./fakegh-state.ts";

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ body: Schema.String })),
);

export class GhExit extends Error {
  readonly code: number;
  readonly stderr: string;

  constructor(code: number, stderr: string) {
    super(stderr);
    this.code = code;
    this.stderr = stderr;
  }
}

export function fail(message: string, code = 1): never {
  throw new GhExit(code, message);
}

export interface Output {
  readonly stdout: string;
  readonly change: GitHubChange | null;
  readonly state: FakeGitHub;
}

const PAGE_INFO = { hasNextPage: false, endCursor: null };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function json(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function urlOf(state: FakeGitHub): string {
  return `https://github.com/${state.owner}/${state.repo}/pull/${state.pr.number}`;
}

function commentUrl(state: FakeGitHub, comment: Comment): string {
  return `${urlOf(state)}#discussion_r${comment.databaseId}`;
}

export function checkNodes(state: FakeGitHub) {
  return state.checks.map((check) => ({
    __typename: "CheckRun",
    name: check.name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    workflowName: check.workflow,
    detailsUrl: `https://github.com/${state.owner}/${state.repo}/actions/runs/9001/job/${check.name}`,
    startedAt: state.pr.createdAt,
    completedAt: state.pr.createdAt,
  }));
}

function graphqlComment(state: FakeGitHub, comment: Comment, thread?: Thread) {
  return {
    id: comment.id,
    databaseId: comment.databaseId,
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    lastEditedAt: comment.updatedAt === comment.createdAt ? null : comment.updatedAt,
    url: commentUrl(state, comment),
    author: { login: comment.author },
    path: thread?.path ?? null,
    line: thread?.line ?? null,
  };
}

function graphqlThread(state: FakeGitHub, thread: Thread) {
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: false,
    path: thread.path,
    line: thread.line,
    comments: {
      pageInfo: PAGE_INFO,
      totalCount: thread.comments.length,
      nodes: thread.comments.map((comment) => graphqlComment(state, comment, thread)),
    },
  };
}

function graphqlReview(state: FakeGitHub, review: Review) {
  return {
    id: review.id,
    databaseId: review.databaseId,
    body: review.body,
    state: review.state,
    submittedAt: review.submittedAt,
    updatedAt: review.submittedAt,
    url: `${urlOf(state)}#pullrequestreview-${review.databaseId}`,
    author: { login: review.author },
  };
}

/** Every field the babysit queries read, whatever subset a query asks for. */
export function graphqlPullRequest(state: FakeGitHub) {
  const { pr } = state;
  const reviews = state.reviews.map((review) => graphqlReview(state, review));

  return {
    id: "PR_kwDOGiftRg4AAAAPull42",
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: urlOf(state),
    state: pr.state,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: pr.state === "OPEN" ? "CLEAN" : "UNKNOWN",
    reviewDecision: "APPROVED",
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    mergedAt: pr.mergedAt,
    author: { login: pr.author },
    reviews: { pageInfo: PAGE_INFO, totalCount: reviews.length, nodes: reviews },
    latestReviews: { pageInfo: PAGE_INFO, totalCount: reviews.length, nodes: reviews },
    comments: {
      pageInfo: PAGE_INFO,
      totalCount: state.comments.length,
      nodes: state.comments.map((comment) => graphqlComment(state, comment)),
    },
    reviewThreads: {
      pageInfo: PAGE_INFO,
      totalCount: state.threads.length,
      nodes: state.threads.map((thread) => graphqlThread(state, thread)),
    },
    commits: {
      pageInfo: PAGE_INFO,
      totalCount: 2,
      nodes: [
        {
          commit: {
            oid: pr.headRefOid,
            messageHeadline: "Mention birthday registries in the README",
            statusCheckRollup: {
              state: "SUCCESS",
              contexts: {
                pageInfo: PAGE_INFO,
                totalCount: state.checks.length,
                nodes: checkNodes(state),
              },
            },
          },
        },
      ],
    },
  };
}

function threadOf(state: FakeGitHub, id: string): Thread {
  return (
    state.threads.find((thread) => thread.id === id) ??
    fail(`Could not resolve to a node with the global id of '${id}'.`)
  );
}

export function nextComment(state: FakeGitHub, body: string): Comment {
  const now = new Date().toISOString();

  return {
    id: `PRRC_kwDOGiftRg4AAAA${state.nextDatabaseId}`,
    databaseId: state.nextDatabaseId,
    author: state.viewer,
    body,
    createdAt: now,
    updatedAt: now,
  };
}

function withThread(state: FakeGitHub, updated: Thread): FakeGitHub {
  return {
    ...state,
    threads: state.threads.map((thread) => (thread.id === updated.id ? updated : thread)),
    nextDatabaseId: state.nextDatabaseId + 1,
  };
}

function replyToThread(state: FakeGitHub, threadId: string, body: string) {
  const thread = threadOf(state, threadId);
  const comment = nextComment(state, body);

  return {
    comment,
    state: withThread(state, { ...thread, comments: [...thread.comments, comment] }),
    change: { kind: "thread-reply", threadId, body } satisfies GitHubChange,
  };
}

/** The value of a variable or of an inline string argument named `name` in a GraphQL request. */
function graphqlValue(query: string, variables: ReadonlyMap<string, string>, name: string) {
  const inline = new RegExp(`${name}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(query)?.[1];

  if (inline !== undefined) return inline;

  const variable = new RegExp(`${name}\\s*:\\s*\\$(\\w+)`).exec(query)?.[1];

  return variable === undefined ? undefined : variables.get(variable);
}

export function graphql(
  state: FakeGitHub,
  query: string,
  variables: ReadonlyMap<string, string>,
): Output {
  if (/\bmutation\b/.test(query)) return graphqlMutation(state, query, variables);

  const threadId = variables.get("thread") ?? variables.get("id");
  const pullRequest = graphqlPullRequest(state);

  const node = threadId === undefined ? null : graphqlThread(state, threadOf(state, threadId));

  const data = {
    viewer: { login: state.viewer },
    repository: {
      name: state.repo,
      nameWithOwner: `${state.owner}/${state.repo}`,
      owner: { login: state.owner },
      pullRequest,
    },
    node,
  };

  return { stdout: json({ data }), change: null, state };
}

function graphqlMutation(
  state: FakeGitHub,
  query: string,
  variables: ReadonlyMap<string, string>,
): Output {
  const threadId =
    graphqlValue(query, variables, "threadId") ??
    graphqlValue(query, variables, "pullRequestReviewThreadId");

  if (/resolveReviewThread/.test(query) && !/unresolveReviewThread/.test(query)) {
    const thread = threadOf(state, threadId ?? fail("resolveReviewThread needs threadId"));

    return {
      stdout: json({
        data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } },
      }),
      change: { kind: "thread-resolve", threadId: thread.id },
      state: withThread(state, { ...thread, isResolved: true }),
    };
  }

  if (/addPullRequestReviewThreadReply/.test(query)) {
    const body = graphqlValue(query, variables, "body") ?? fail("the reply needs a body");
    const reply = replyToThread(state, threadId ?? fail("the reply needs a thread"), body);

    return {
      stdout: json({
        data: {
          addPullRequestReviewThreadReply: { comment: graphqlComment(reply.state, reply.comment) },
        },
      }),
      change: reply.change,
      state: reply.state,
    };
  }

  return fail("GraphQL: this mutation is not available to this token (FORBIDDEN)");
}

function restComment(state: FakeGitHub, thread: Thread, comment: Comment) {
  return {
    id: comment.databaseId,
    node_id: comment.id,
    in_reply_to_id: comment === thread.comments[0] ? null : thread.comments[0].databaseId,
    body: comment.body,
    user: { login: comment.author, type: comment.author === "coderabbitai" ? "Bot" : "User" },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    path: thread.path,
    line: thread.line,
    html_url: commentUrl(state, comment),
  };
}

function restPullRequest(state: FakeGitHub) {
  const { pr } = state;

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state === "OPEN" ? "open" : "closed",
    draft: false,
    merged: pr.state === "MERGED",
    mergeable: true,
    mergeable_state: "clean",
    html_url: urlOf(state),
    user: { login: pr.author },
    head: { ref: pr.headRefName, sha: pr.headRefOid },
    base: { ref: pr.baseRefName },
    created_at: pr.createdAt,
    merged_at: pr.mergedAt,
  };
}

function commentById(state: FakeGitHub, databaseId: number) {
  for (const thread of state.threads) {
    const comment = thread.comments.find((candidate) => candidate.databaseId === databaseId);

    if (comment) return { thread, comment };
  }

  return fail("Not Found (HTTP 404)");
}

export function requestBody(
  fields: ReadonlyMap<string, string>,
  input: string | undefined,
): string {
  if (input !== undefined) return decodeBody(readFileSync(input === "-" ? 0 : input, "utf8")).body;

  return fields.get("body") ?? fail("Validation Failed: body is required (HTTP 422)");
}

export function rest(
  state: FakeGitHub,
  method: string,
  endpoint: string,
  fields: ReadonlyMap<string, string>,
  input: string | undefined,
): Output {
  const repo = `repos/${state.owner}/${state.repo}`;
  const path = endpoint.replace(/^\//, "").replace(/\?.*$/, "");
  const pull = `${repo}/pulls/${state.pr.number}`;
  const read = (value: JsonValue): Output => ({ stdout: json(value), change: null, state });

  if (path === "user") return read({ login: state.viewer, type: "User" });

  if (path === repo)
    return read({
      name: state.repo,
      full_name: `${state.owner}/${state.repo}`,
      default_branch: "main",
    });

  if (path === pull) return read(restPullRequest(state));

  if (path === `${repo}/pulls`) return read([restPullRequest(state)]);

  if (path === `${pull}/reviews`) {
    return read(
      state.reviews.map((review) => ({
        id: review.databaseId,
        node_id: review.id,
        user: { login: review.author },
        state: review.state,
        body: review.body,
        submitted_at: review.submittedAt,
      })),
    );
  }

  if (path === `${pull}/comments` && method === "GET") {
    return read(
      state.threads.flatMap((thread) =>
        thread.comments.map((comment) => restComment(state, thread, comment)),
      ),
    );
  }

  if (path === `${repo}/issues/${state.pr.number}/comments` && method === "GET") {
    return read(
      state.comments.map((comment) => ({
        id: comment.databaseId,
        node_id: comment.id,
        body: comment.body,
        user: { login: comment.author },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      })),
    );
  }

  if (path === `${repo}/issues/${state.pr.number}/comments`) {
    const comment = nextComment(state, requestBody(fields, input));

    return {
      stdout: json({ id: comment.databaseId, body: comment.body }),
      change: { kind: "pr-comment", body: comment.body },
      state: {
        ...state,
        comments: [...state.comments, comment],
        nextDatabaseId: state.nextDatabaseId + 1,
      },
    };
  }

  const replies = new RegExp(`^${pull}/comments/(\\d+)/replies$`).exec(path);

  if (replies) {
    const { thread } = commentById(state, Number(replies[1]));
    const reply = replyToThread(state, thread.id, requestBody(fields, input));

    return {
      stdout: json(restComment(reply.state, thread, reply.comment)),
      change: reply.change,
      state: reply.state,
    };
  }

  const single = new RegExp(`^${repo}/pulls/comments/(\\d+)$`).exec(path);

  if (single) {
    const { thread, comment } = commentById(state, Number(single[1]));

    if (method === "GET") return read(restComment(state, thread, comment));

    const body = requestBody(fields, input);

    return {
      stdout: json({ ...restComment(state, thread, comment), body }),
      change: { kind: "comment-edit", databaseId: comment.databaseId, body },
      state,
    };
  }

  if (/^repos\/[^/]+\/[^/]+\/commits\/[^/]+\/check-runs$/.test(path)) {
    return read({
      total_count: state.checks.length,
      check_runs: state.checks.map((check) => ({
        name: check.name,
        status: "completed",
        conclusion: "success",
      })),
    });
  }

  if (/^repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status$/.test(path))
    return read({ state: "success", statuses: [] });

  return fail("gh: Not Found (HTTP 404)");
}
