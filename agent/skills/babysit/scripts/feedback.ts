import {
  at,
  enumValue,
  list,
  missing,
  optionalString,
  parseAuthor,
  record,
  runJson,
  string,
} from "./github.ts";
import type * as T from "./types.ts";

export interface FeedbackComment {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly authorIsBot: boolean;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type SubmittedReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED";
export interface SubmittedReview {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly authorIsBot: boolean;
  readonly body: string;
  readonly url: string;
  readonly state: SubmittedReviewState;
  readonly submittedAt: string;
  readonly updatedAt: string;
}
export interface ThreadComment extends FeedbackComment {
  readonly path: string | null;
  readonly line: number | null;
}
export interface FeedbackThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly comments: readonly ThreadComment[];
}
export interface FeedbackSnapshot {
  readonly viewerLogin: string;
  readonly reviews: readonly SubmittedReview[];
  readonly comments: readonly FeedbackComment[];
  readonly threads: readonly FeedbackThread[];
}
export interface FeedbackReader {
  feedback(context: T.PrContext): Promise<FeedbackSnapshot>;
}

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const AUTHOR_FIELDS = "author { __typename login }";
const COMMENT_FIELDS = `id body createdAt updatedAt url ${AUTHOR_FIELDS}`;
const THREAD_COMMENT_FIELDS = `${COMMENT_FIELDS} path line`;
export const FEEDBACK_REVIEWS_QUERY = `
query FeedbackReviews($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviews(first: 100, after: $after) {
        ${PAGE_INFO}
        nodes { id body state submittedAt updatedAt url ${AUTHOR_FIELDS} }
      }
    }
  }
}
`;
export const FEEDBACK_COMMENTS_QUERY = `
query FeedbackComments($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      comments(first: 100, after: $after) {
        ${PAGE_INFO}
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}
`;
export const FEEDBACK_THREADS_QUERY = `
query FeedbackThreads($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        ${PAGE_INFO}
        nodes {
          id
          isResolved
          comments(first: 100) {
            ${PAGE_INFO}
            nodes { ${THREAD_COMMENT_FIELDS} }
          }
        }
      }
    }
  }
}
`;
export const FEEDBACK_THREAD_COMMENTS_QUERY = `
query FeedbackThreadComments($thread: ID!, $after: String) {
  node(id: $thread) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) {
        ${PAGE_INFO}
        nodes { ${THREAD_COMMENT_FIELDS} }
      }
    }
  }
}
`;
export type GraphqlQuery = (request: {
  readonly query: string;
  readonly variables: Readonly<Record<string, string | number>>;
}) => Promise<unknown>;
const ghGraphql: GraphqlQuery = (request) => {
  const argv: [string, ...string[]] = [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${request.query}`,
  ];
  for (const [key, value] of Object.entries(request.variables))
    argv.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  return runJson(argv);
};
function graphqlData(value: unknown, label: string): unknown {
  const object = record(value, label);
  if (object.errors !== undefined) missing(`${label}.errors`, object.errors);
  return object;
}
function connectionCursor(connection: Record<string, unknown>, path: string) {
  const page = record(connection.pageInfo, `${path}.pageInfo`);
  if (typeof page.hasNextPage !== "boolean")
    missing(`${path}.pageInfo.hasNextPage`, page.hasNextPage);
  if (!page.hasNextPage) return null;
  return string(page.endCursor, `${path}.pageInfo.endCursor`);
}
function author(value: unknown, path: string) {
  const parsed = parseAuthor(value, `${path}.author`);
  return {
    authorLogin: parsed?.login ?? null,
    authorIsBot: parsed?.isBot ?? false,
  };
}
function parseFeedbackComment(value: unknown, path: string): FeedbackComment {
  const object = record(value, path);
  return {
    id: string(object.id, `${path}.id`),
    ...author(object.author, path),
    body: string(object.body, `${path}.body`),
    url: string(object.url, `${path}.url`),
    createdAt: string(object.createdAt, `${path}.createdAt`),
    updatedAt: string(object.updatedAt, `${path}.updatedAt`),
  };
}
function parseThreadComment(value: unknown, path: string): ThreadComment {
  const object = record(value, path);
  const line = object.line;
  if (line !== null && !Number.isInteger(line)) missing(`${path}.line`, line);
  return {
    ...parseFeedbackComment(object, path),
    path: optionalString(object.path, `${path}.path`),
    line: typeof line === "number" ? line : null,
  };
}
const REVIEW_STATES = [
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
] as const;
function parseReview(value: unknown): SubmittedReview | null {
  const object = record(value, "review");
  const state = enumValue(object.state, REVIEW_STATES, "review.state");
  if (state === "PENDING") return null;
  return {
    id: string(object.id, "review.id"),
    ...author(object.author, "review"),
    body: string(object.body, "review.body"),
    url: string(object.url, "review.url"),
    state,
    submittedAt: string(object.submittedAt, "review.submittedAt"),
    updatedAt: string(object.updatedAt, "review.updatedAt"),
  };
}
function pullRequestConnection(value: unknown, field: string) {
  return record(
    at(graphqlData(value, field), ["data", "repository", "pullRequest", field]),
    field
  );
}
export function parseFeedbackReviewPage(value: unknown) {
  const connection = pullRequestConnection(value, "reviews");
  const viewer = at(value, ["data", "viewer", "login"]);
  const reviews: SubmittedReview[] = [];
  for (const node of list(connection.nodes, "reviews.nodes")) {
    const review = parseReview(node);
    if (review !== null) reviews.push(review);
  }
  return {
    viewerLogin: string(viewer, "viewer.login"),
    reviews,
    endCursor: connectionCursor(connection, "reviews"),
  };
}
export function parseFeedbackCommentPage(value: unknown) {
  const connection = pullRequestConnection(value, "comments");
  return {
    comments: list(connection.nodes, "comments.nodes").map((node) =>
      parseFeedbackComment(node, "comment")
    ),
    endCursor: connectionCursor(connection, "comments"),
  };
}
function threadComments(connection: Record<string, unknown>, path: string) {
  return {
    comments: list(connection.nodes, `${path}.nodes`).map((node) =>
      parseThreadComment(node, "thread comment")
    ),
    endCursor: connectionCursor(connection, path),
  };
}
export function parseFeedbackThreadPage(value: unknown) {
  const connection = pullRequestConnection(value, "reviewThreads");
  return {
    threads: list(connection.nodes, "reviewThreads.nodes").map((node) => {
      const thread = record(node, "review thread");
      if (typeof thread.isResolved !== "boolean")
        missing("review thread.isResolved", thread.isResolved);
      return {
        id: string(thread.id, "review thread.id"),
        isResolved: thread.isResolved,
        ...threadComments(
          record(thread.comments, "review thread.comments"),
          "review thread.comments"
        ),
      };
    }),
    endCursor: connectionCursor(connection, "reviewThreads"),
  };
}
export function parseThreadCommentPage(value: unknown) {
  const node = record(
    at(graphqlData(value, "thread"), ["data", "node"]),
    "thread node"
  );
  return threadComments(
    record(node.comments, "thread node.comments"),
    "thread node.comments"
  );
}
async function drain<P extends { readonly endCursor: string | null }>(
  label: string,
  fetch: (after: string | null) => Promise<P>,
  first?: P
): Promise<T.NonEmpty<P>> {
  const pages: [P, ...P[]] = [first ?? (await fetch(null))];
  const cursors = new Set<string>();
  let after = pages[0].endCursor;
  while (after !== null) {
    if (cursors.has(after)) missing(`${label}.pageInfo.endCursor`, after);
    cursors.add(after);
    const page = await fetch(after);
    pages.push(page);
    after = page.endCursor;
  }
  return pages;
}
function pageVariables(
  context: T.PrContext,
  after: string | null
): Record<string, string | number> {
  const variables: Record<string, string | number> = {
    owner: context.owner,
    repo: context.repo,
    pr: context.number,
  };
  if (after !== null) variables.after = after;
  return variables;
}
export async function readFeedback(
  query: GraphqlQuery,
  context: T.PrContext
): Promise<FeedbackSnapshot> {
  const reviewPages = await drain("reviews", async (after) =>
    parseFeedbackReviewPage(
      await query({
        query: FEEDBACK_REVIEWS_QUERY,
        variables: pageVariables(context, after),
      })
    )
  );
  const commentPages = await drain("comments", async (after) =>
    parseFeedbackCommentPage(
      await query({
        query: FEEDBACK_COMMENTS_QUERY,
        variables: pageVariables(context, after),
      })
    )
  );
  const threadPages = await drain("reviewThreads", async (after) =>
    parseFeedbackThreadPage(
      await query({
        query: FEEDBACK_THREADS_QUERY,
        variables: pageVariables(context, after),
      })
    )
  );
  const threads: FeedbackThread[] = [];
  for (const page of threadPages)
    for (const thread of page.threads) {
      const commentPages = await drain(
        "thread node.comments",
        async (after) =>
          parseThreadCommentPage(
            await query({
              query: FEEDBACK_THREAD_COMMENTS_QUERY,
              variables:
                after === null
                  ? { thread: thread.id }
                  : { thread: thread.id, after },
            })
          ),
        thread
      );
      threads.push({
        id: thread.id,
        isResolved: thread.isResolved,
        comments: commentPages.flatMap((page) => page.comments),
      });
    }
  return {
    viewerLogin: reviewPages[0].viewerLogin,
    reviews: reviewPages.flatMap((page) => page.reviews),
    comments: commentPages.flatMap((page) => page.comments),
    threads,
  };
}
export const ghFeedbackReader: FeedbackReader = {
  feedback: (context) => readFeedback(ghGraphql, context),
};
