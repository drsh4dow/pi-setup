import { describe, expect, it } from "bun:test";
import {
  ChecksUnavailable,
  WatcherQueryError,
  buildReviewThreads,
  mapRollupNode,
  orderStack,
  parseFastCheck,
  parsePullRequest,
  parseReviewThreadPage,
  readFeedback,
  resolveChecks,
  resolveContext,
  resolveReviewThreads,
} from "./github.ts";
import {
  fakeReader,
  failedCheck,
  passingCheck,
  pendingCheck,
} from "./fakes.test-helper.ts";
import { parsePrNumber } from "./types.ts";
import type { GraphqlQuery } from "./github.ts";

const context = {
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(42),
};

describe("checks fallback chain", () => {
  it("uses a non-empty fast-path result without a rollup query", async () => {
    const reader = fakeReader({
      fastPath: { kind: "checks", checks: [passingCheck("fast")] },
    });
    const read = await resolveChecks(reader, context);
    expect(read.source).toBe("gh-pr-checks");
    expect(read.checks.map((check) => check.name)).toEqual(["fast"]);
    expect(reader.calls).toEqual(["checksFastPath"]);
  });

  it("paginates GraphQL when the fast path is unusable", async () => {
    const reader = fakeReader({
      fastPath: { kind: "unusable", exitCode: 8, stderr: "" },
      rollupPages: [
        { checks: [passingCheck("first")], endCursor: "next" },
        { checks: [failedCheck("second")], endCursor: null },
      ],
    });
    const read = await resolveChecks(reader, context);
    expect(read.source).toBe("graphql-rollup");
    expect(read.checks.map((check) => check.name)).toEqual(["first", "second"]);
    expect(reader.calls).toEqual([
      "checksFastPath",
      "checkRollupPage:null",
      "checkRollupPage:next",
    ]);
  });

  it("falls back when valid fast-path JSON represented an empty list", async () => {
    const reader = fakeReader({
      fastPath: { kind: "checks", checks: [] },
      rollupPages: [{ checks: [pendingCheck("fallback")], endCursor: null }],
    });
    expect((await resolveChecks(reader, context)).checks[0].name).toBe(
      "fallback"
    );
    expect(reader.calls).toEqual(["checksFastPath", "checkRollupPage:null"]);
  });

  it("fails closed when both paths are empty", async () => {
    const reader = fakeReader({
      fastPath: {
        kind: "unusable",
        exitCode: 8,
        stderr: "credential cannot read checks",
      },
    });
    await expect(resolveChecks(reader, context)).rejects.toBeInstanceOf(
      ChecksUnavailable
    );
    expect(reader.calls).toEqual(["checksFastPath", "checkRollupPage:null"]);
  });
});

describe("rollup node mapping", () => {
  it("maps terminal and non-terminal CheckRun states fail closed", () => {
    const cases = [
      ["IN_PROGRESS", null, "pending", "PENDING"],
      ["COMPLETED", "SUCCESS", "passed", "SUCCESS"],
      ["COMPLETED", "NEUTRAL", "skipped", "NEUTRAL"],
      ["COMPLETED", "SKIPPED", "skipped", "SKIPPED"],
      ["COMPLETED", "ACTION_REQUIRED", "failed", "ACTION_REQUIRED"],
      ["COMPLETED", "TIMED_OUT", "failed", "FAILURE"],
      ["COMPLETED", "FUTURE_VALUE", "failed", "FAILURE"],
    ] as const;
    for (const [status, conclusion, kind, reportedState] of cases) {
      expect(
        mapRollupNode({
          __typename: "CheckRun",
          name: "ci",
          status,
          conclusion,
        })
      ).toMatchObject({ kind, reportedState });
    }
  });

  it("classifies an in-progress Code Review Gate from the rollup as the gate", () => {
    expect(
      mapRollupNode({
        __typename: "CheckRun",
        name: "Code Review Gate",
        status: "IN_PROGRESS",
        conclusion: null,
      })
    ).toMatchObject({ kind: "code-review-gate" });
    expect(
      mapRollupNode({
        __typename: "StatusContext",
        context: "Code Review Gate",
        state: "PENDING",
      })
    ).toMatchObject({ kind: "code-review-gate" });
  });

  it("classifies a Code Review Gate waiting on an owner approval as the gate", () => {
    expect(
      mapRollupNode({
        __typename: "CheckRun",
        name: "Code Review Gate",
        status: "COMPLETED",
        conclusion: "ACTION_REQUIRED",
        description: "1 of 2 policies",
      })
    ).toMatchObject({
      kind: "code-review-gate",
      reportedState: "ACTION_REQUIRED",
    });
  });

  it("classifies a fast-path Code Review Gate waiting on an owner approval as the gate", () => {
    expect(
      parseFastCheck({
        name: "Code Review Gate",
        state: "ACTION_REQUIRED",
        bucket: "fail",
      })
    ).toMatchObject({
      kind: "code-review-gate",
      reportedState: "ACTION_REQUIRED",
    });
    expect(
      parseFastCheck({ name: "ci", state: "ACTION_REQUIRED", bucket: "fail" })
    ).toMatchObject({ kind: "failed", reportedState: "ACTION_REQUIRED" });
  });

  it("maps StatusContext states and drops unknown typenames", () => {
    expect(
      mapRollupNode({
        __typename: "StatusContext",
        context: "ci",
        state: "EXPECTED",
      })
    ).toMatchObject({ kind: "pending", reportedState: "PENDING" });
    expect(
      mapRollupNode({
        __typename: "StatusContext",
        context: "ci",
        state: "FUTURE_VALUE",
      })
    ).toMatchObject({ kind: "failed", reportedState: "FUTURE_VALUE" });
    expect(mapRollupNode({ __typename: "FutureNode" })).toBeNull();
  });
});

describe("closed enum parsing", () => {
  const rawPullRequest = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };

  it("accepts mergeStateStatus CONFLICTING", () => {
    expect(
      parsePullRequest(
        { ...rawPullRequest, mergeStateStatus: "CONFLICTING" },
        context
      ).mergeStateStatus
    ).toBe("CONFLICTING");
  });

  it("reads gh's empty reviewDecision as no decision rather than a parse failure", () => {
    expect(
      parsePullRequest({ ...rawPullRequest, reviewDecision: "" }, context)
        .reviewDecision
    ).toBeNull();
  });

  it("still rejects an unknown reviewDecision", () => {
    expect(() =>
      parsePullRequest({ ...rawPullRequest, reviewDecision: "MAYBE" }, context)
    ).toThrow(WatcherQueryError);
  });

  it("rejects unknown enum values as retryable errors carrying the raw value", () => {
    try {
      parsePullRequest(
        { ...rawPullRequest, mergeStateStatus: "FUTURE_STATE" },
        context
      );
      throw new Error("expected parser to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WatcherQueryError);
      if (!(error instanceof WatcherQueryError)) throw error;
      expect(error.failure).toMatchObject({
        kind: "missing-key",
        retryable: true,
        rawValue: '"FUTURE_STATE"',
      });
    }
  });
});

it("annotates Bugbot threads with distinct review-pass counts", () => {
  const response = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "one",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      body: "RUN_ID: run-1",
                      createdAt: "now",
                      path: "a.ts",
                      line: 1,
                      author: { login: "bugbot" },
                    },
                  ],
                },
              },
              {
                id: "two",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      body: "CURSOR_AUTOMATION_ID: run-2 severity high",
                      createdAt: "now",
                      path: null,
                      line: null,
                      author: { login: "cursor" },
                    },
                  ],
                },
              },
              {
                id: "resolved",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      body: "RUN_ID: run-3",
                      createdAt: "now",
                      path: null,
                      line: null,
                      author: { login: "bugbot" },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const threads = buildReviewThreads(parseReviewThreadPage(response).threads);
  expect(threads).toHaveLength(2);
  expect(threads.map((thread) => thread.isBugbot)).toEqual([true, true]);
  expect(threads.map((thread) => thread.bugbotReviewPasses)).toEqual([3, 3]);
});

describe("review thread pagination", () => {
  const thread = (id: string, resolved = false) => ({
    id,
    firstComment: {
      authorLogin: "someone",
      body: "please fix",
      path: "a.ts",
      line: 1,
      createdAt: "now",
    },
    resolved,
  });

  it("keeps walking pages until the cursor is exhausted", async () => {
    const reader = fakeReader({
      threadPages: [
        { threads: [thread("one")], endCursor: "next" },
        { threads: [thread("two")], endCursor: "last" },
        { threads: [thread("three")], endCursor: null },
      ],
    });
    const threads = await resolveReviewThreads(reader, context);
    expect(threads.map((item) => item.id)).toEqual(["one", "two", "three"]);
    expect(reader.calls).toEqual([
      "reviewThreadPage:null",
      "reviewThreadPage:next",
      "reviewThreadPage:last",
    ]);
  });

  it("sees an unresolved thread that sits past the first page", async () => {
    const reader = fakeReader({
      threadPages: [
        { threads: [thread("early", true)], endCursor: "next" },
        { threads: [thread("late")], endCursor: null },
      ],
    });
    const threads = await resolveReviewThreads(reader, context);
    expect(threads.map((item) => item.id)).toEqual(["late"]);
  });

  it("stops after a single page when the cursor is exhausted", async () => {
    const reader = fakeReader({
      threadPages: [{ threads: [thread("only")], endCursor: null }],
    });
    expect((await resolveReviewThreads(reader, context)).length).toBe(1);
    expect(reader.calls).toEqual(["reviewThreadPage:null"]);
  });

  it("counts Bugbot review passes across every page", async () => {
    const bugbot = (id: string, runId: string) => ({
      id,
      firstComment: {
        authorLogin: "bugbot",
        body: `RUN_ID: ${runId}`,
        path: "a.ts",
        line: 1,
        createdAt: "now",
      },
      resolved: false,
    });
    const reader = fakeReader({
      threadPages: [
        { threads: [bugbot("one", "run-1")], endCursor: "next" },
        { threads: [bugbot("two", "run-2")], endCursor: null },
      ],
    });
    const threads = await resolveReviewThreads(reader, context);
    expect(threads.map((item) => item.bugbotReviewPasses)).toEqual([2, 2]);
  });

  it("drops resolved threads from later pages too", async () => {
    const reader = fakeReader({
      threadPages: [
        { threads: [thread("one")], endCursor: "next" },
        { threads: [thread("two", true)], endCursor: null },
      ],
    });
    expect(
      (await resolveReviewThreads(reader, context)).map((item) => item.id)
    ).toEqual(["one"]);
  });

  it("rejects a page that omits pageInfo instead of assuming one page", async () => {
    const response = {
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [] } },
        },
      },
    };
    expect(() => parseReviewThreadPage(response)).toThrow(WatcherQueryError);
  });
});

describe("context and stack discovery", () => {
  it("returns a fully explicit context without any reader call", async () => {
    const reader = fakeReader();
    expect(
      await resolveContext({
        reader,
        owner: "explicit",
        repo: "repo",
        pr: context.number,
      })
    ).toEqual({ owner: "explicit", repo: "repo", number: context.number });
    expect(reader.calls).toEqual([]);
  });

  it("uses the local origin before currentPr for an explicit number", async () => {
    const reader = fakeReader({ origin: { owner: "local", repo: "checkout" } });
    expect(
      await resolveContext({
        reader,
        owner: null,
        repo: null,
        pr: context.number,
      })
    ).toEqual({ owner: "local", repo: "checkout", number: context.number });
    expect(reader.calls).toEqual(["originRepo"]);
  });

  it("orders the connected stack bottom-to-top", () => {
    const ordered = orderStack(context, [
      {
        number: parsePrNumber(41),
        headRefName: "base-feature",
        baseRefName: "main",
      },
      {
        number: context.number,
        headRefName: "feature",
        baseRefName: "base-feature",
      },
      {
        number: parsePrNumber(43),
        headRefName: "upstack",
        baseRefName: "feature",
      },
    ]);
    expect(ordered.map((item) => Number(item.number))).toEqual([41, 42, 43]);
  });
});

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
