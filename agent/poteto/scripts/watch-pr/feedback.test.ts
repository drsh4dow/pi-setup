import { describe, expect, it } from "bun:test";
import { readFeedback, type GraphqlQuery } from "./feedback.ts";
import { WatcherQueryError } from "./github.ts";
import { parsePrNumber } from "./types.ts";

const context = {
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(42),
};

describe("feedback reads", () => {
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    body: `body ${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/owner/repo/pull/42#${id}`,
    author: { login: "alice" },
    ...extra,
  });
  const page = (nodes: readonly unknown[], next: string | null) => ({
    pageInfo: { hasNextPage: next !== null, endCursor: next },
    nodes,
  });
  const range = (prefix: string, count: number, extra = {}) =>
    Array.from({ length: count }, (_, index) => node(`${prefix}${index}`, extra));
  const threadComment = { path: "a.ts", line: 3 };
  type Pages = Record<string, unknown>;
  function graphql(pages: Pages): GraphqlQuery & { requests: string[] } {
    const requests: string[] = [];
    const query: GraphqlQuery = async ({ query, variables }) => {
      const name = /query (\w+)/.exec(query)?.[1] ?? "unknown";
      const key = `${name}:${variables.thread ?? ""}:${variables.after ?? ""}`;
      requests.push(key);
      if (!(key in pages)) throw new Error(`unexpected request ${key}`);
      return pages[key];
    };
    return Object.assign(query, { requests });
  }
  const reviews = (connection: unknown) => ({
    data: {
      viewer: { login: "operator" },
      repository: { pullRequest: { reviews: connection } },
    },
  });
  const comments = (connection: unknown) => ({
    data: { repository: { pullRequest: { comments: connection } } },
  });
  const threads = (connection: unknown) => ({
    data: { repository: { pullRequest: { reviewThreads: connection } } },
  });
  const basePages: Pages = {
    "FeedbackReviews::": reviews(
      page(
        [
          node("r1", { state: "COMMENTED", submittedAt: "2026-01-01T00:00:00Z" }),
          node("draft", { state: "PENDING", submittedAt: null }),
          node("ghost", {
            state: "APPROVED",
            submittedAt: "2026-01-01T00:00:00Z",
            author: null,
          }),
        ],
        null
      )
    ),
    "FeedbackComments::": comments(page(range("c", 100), "c-next")),
    "FeedbackComments::c-next": comments(page(range("d", 50), null)),
    "FeedbackThreads::": threads(
      page(
        [
          {
            id: "t1",
            isResolved: true,
            comments: page(range("t", 100, threadComment), "t-next"),
          },
        ],
        null
      )
    ),
    "FeedbackThreadComments:t1:t-next": {
      data: { node: { comments: page(range("u", 20, threadComment), null) } },
    },
  };

  it("drains every connection, nested thread comments included", async () => {
    const query = graphql(basePages);
    const snapshot = await readFeedback(query, context);
    expect(snapshot.viewerLogin).toBe("operator");
    expect(snapshot.reviews.map((review) => [review.id, review.authorLogin])).toEqual([
      ["r1", "alice"],
      ["ghost", null],
    ]);
    expect(snapshot.comments).toHaveLength(150);
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]?.isResolved).toBe(true);
    expect(snapshot.threads[0]?.comments).toHaveLength(120);
    expect(snapshot.threads[0]?.comments.at(-1)).toMatchObject({
      id: "u19",
      path: "a.ts",
      line: 3,
    });
  });

  it("fails the whole read on a malformed later page", async () => {
    const query = graphql({
      ...basePages,
      "FeedbackComments::c-next": comments(page([{ id: "broken" }], null)),
    });
    await expect(readFeedback(query, context)).rejects.toBeInstanceOf(
      WatcherQueryError
    );
  });

  it("rejects GraphQL errors and a repeated cursor", async () => {
    const withErrors = graphql({
      ...basePages,
      "FeedbackComments::": { ...comments(page([], null)), errors: [{ message: "x" }] },
    });
    await expect(readFeedback(withErrors, context)).rejects.toBeInstanceOf(
      WatcherQueryError
    );
    const looping = graphql({
      ...basePages,
      "FeedbackComments::c-next": comments(page(range("d", 1), "c-next")),
    });
    await expect(readFeedback(looping, context)).rejects.toBeInstanceOf(
      WatcherQueryError
    );
  });
});
