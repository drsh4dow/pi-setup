import { describe, expect, it } from "bun:test";
import {
  ChecksUnavailable,
  GhGitHubReader,
  WatcherQueryError,
  buildReviewThreads,
  countReviewPasses,
  mapRollupNode,
  orderStack,
  parseFastCheck,
  parsePullRequest,
  parseReviewPage,
  parseReviewThreadPage,
  resolveChecks,
  readReviewThreads,
  resolveContext,
  resolveReviewPasses,
} from "./github.ts";
import {
  botReview,
  fakeReader,
  failedCheck,
  passingCheck,
  pendingCheck,
  selectedFields,
} from "./fakes.test-helper.ts";
import type { RawReview } from "./types.ts";
import { parsePrNumber } from "./types.ts";

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
    expect(await resolveChecks(reader, context)).toMatchObject({
      kind: "checks",
      source: "gh-pr-checks",
      checks: [{ name: "fast" }],
    });
    expect(reader.calls).toEqual(["checksFastPath"]);
  });

  it("paginates GraphQL when the fast path is unusable", async () => {
    const reader = fakeReader({
      fastPath: { kind: "unusable", exitCode: 8, stderr: "" },
      rollupPages: [
        { kind: "contexts", checks: [passingCheck("first")], endCursor: "next" },
        { kind: "contexts", checks: [failedCheck("second")], endCursor: null },
      ],
    });
    expect(await resolveChecks(reader, context)).toMatchObject({
      kind: "checks",
      source: "graphql-rollup",
      checks: [{ name: "first" }, { name: "second" }],
    });
    expect(reader.calls).toEqual([
      "checksFastPath",
      "checkRollupPage:null",
      "checkRollupPage:next",
    ]);
  });

  it("falls back when valid fast-path JSON represented an empty list", async () => {
    const reader = fakeReader({
      fastPath: { kind: "checks", checks: [] },
      rollupPages: [
        { kind: "contexts", checks: [pendingCheck("fallback")], endCursor: null },
      ],
    });
    expect(await resolveChecks(reader, context)).toMatchObject({
      checks: [{ name: "fallback" }],
    });
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

  it("reports no checks when gh finds none and the head commit has no rollup", async () => {
    const reader = fakeReader({
      fastPath: {
        kind: "unusable",
        exitCode: 1,
        stderr: "no checks reported on the 'feature' branch\n",
      },
      rollupPages: [{ kind: "no-rollup" }],
    });
    expect(await resolveChecks(reader, context)).toEqual({ kind: "no-checks" });
  });

  it("fails closed when gh finds no checks but the head commit has an empty rollup", async () => {
    const reader = fakeReader({
      fastPath: {
        kind: "unusable",
        exitCode: 1,
        stderr: "no checks reported on the 'feature' branch",
      },
      rollupPages: [{ kind: "contexts", checks: [], endCursor: null }],
    });
    await expect(resolveChecks(reader, context)).rejects.toBeInstanceOf(
      ChecksUnavailable
    );
  });

  it("fails closed when the head commit has no rollup but gh failed for another reason", async () => {
    const reader = fakeReader({
      fastPath: {
        kind: "unusable",
        exitCode: 8,
        stderr: "credential cannot read checks",
      },
      rollupPages: [{ kind: "no-rollup" }],
    });
    await expect(resolveChecks(reader, context)).rejects.toBeInstanceOf(
      ChecksUnavailable
    );
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

it("counts each Bugbot author's distinct runs across resolved and open threads", () => {
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
  const raw = parseReviewThreadPage(response).threads;
  const threads = buildReviewThreads(raw);
  expect(threads).toHaveLength(2);
  expect(threads.map((thread) => thread.isBugbot)).toEqual([true, true]);
  expect(countReviewPasses([], raw)).toMatchObject([
    { author: "bugbot", passes: 2 },
    { author: "cursor", passes: 1 },
  ]);
});

describe("review passes per bot author", () => {
  const acme = (
    id: string,
    commitOid: string,
    body: string,
    submittedAt: string
  ): RawReview => botReview({ id, commitOid, body, submittedAt });
  const headA = [
    acme("a-summary", "A", "Summary: 2 findings", "2026-01-01T00:00:00Z"),
    acme("a-inline", "A", "", "2026-01-01T00:00:05Z"),
  ];
  const headB = [
    acme("b-summary", "B", "Summary: 1 finding", "2026-01-01T01:00:00Z"),
    acme("b-inline", "B", "  \n", "2026-01-01T01:00:05Z"),
  ];

  it("counts one pass per head commit for a bot that is not Cursor Bugbot", () => {
    expect(countReviewPasses([...headA, ...headB], [])).toEqual([
      {
        author: "acme-review[bot]",
        passes: 2,
        latestPass: {
          reviewId: "b-summary",
          commitOid: "B",
          submittedAt: "2026-01-01T01:00:00Z",
        },
      },
    ]);
  });

  it("counts two bots on the same head commits independently", () => {
    const lint = (id: string, commitOid: string, submittedAt: string) =>
      botReview({ id, author: "lint-bot", commitOid, body: "1 issue", submittedAt });
    const reviews = [
      ...headA,
      lint("l-a", "A", "2026-01-01T00:01:00Z"),
      ...headB,
      lint("l-b", "B", "2026-01-01T01:01:00Z"),
      lint("l-c", "C", "2026-01-01T02:00:00Z"),
    ];
    expect(countReviewPasses(reviews, [])).toEqual([
      {
        author: "acme-review[bot]",
        passes: 2,
        latestPass: {
          reviewId: "b-summary",
          commitOid: "B",
          submittedAt: "2026-01-01T01:00:00Z",
        },
      },
      {
        author: "lint-bot",
        passes: 3,
        latestPass: {
          reviewId: "l-c",
          commitOid: "C",
          submittedAt: "2026-01-01T02:00:00Z",
        },
      },
    ]);
  });

  it("counts a summary and an empty review at one head as one pass", () => {
    expect(countReviewPasses(headA, [])).toEqual([
      {
        author: "acme-review[bot]",
        passes: 1,
        latestPass: {
          reviewId: "a-summary",
          commitOid: "A",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      },
    ]);
  });

  it("counts two non-empty reviews at one head as one pass", () => {
    const followUp = acme("a-follow-up", "A", "One more note", "2026-01-01T00:10:00Z");
    expect(countReviewPasses([...headA, followUp], [])).toMatchObject([
      { passes: 1, latestPass: { reviewId: "a-follow-up" } },
    ]);
  });

  it("counts no pass for a bot that posted only empty reviews, or for a human", () => {
    const human: RawReview = {
      ...acme("h1", "A", "looks good", "2026-01-01T00:00:00Z"),
      authorLogin: "alice",
      authorIsBot: false,
    };
    expect(countReviewPasses([headA[1], human], [])).toEqual([]);
  });

  it("keeps Cursor Bugbot's passes from its threads when its reviews show fewer", () => {
    const run = (id: string, runId: string) => ({
      id,
      firstComment: {
        authorLogin: "cursor",
        body: `bugbot RUN_ID: ${runId}`,
        path: "a.ts",
        line: 1,
        createdAt: "now",
      },
      resolved: false,
    });
    const review: RawReview = {
      ...acme("c1", "A", "Bugbot reviewed your changes", "2026-01-01T00:00:00Z"),
      authorLogin: "cursor",
    };
    expect(
      countReviewPasses(
        [review],
        [run("1", "run-1"), run("2", "run-2"), run("3", "run-3")]
      )
    ).toEqual([
      {
        author: "cursor",
        passes: 3,
        latestPass: {
          reviewId: "c1",
          commitOid: "A",
          submittedAt: "2026-01-01T00:00:00Z",
        },
      },
    ]);
  });

  it("reads every page of reviews and asks GraphQL for the author type", async () => {
    const node = (id: string, commitOid: string, login: string, typename: string) => ({
      id,
      body: "Summary: 1 finding",
      state: "COMMENTED",
      submittedAt: `2026-01-01T0${id.at(-1)}:00:00Z`,
      url: `https://github.com/owner/repo/pull/42#${id}`,
      commit: { oid: commitOid },
      author: { __typename: typename, login },
    });
    const response = (nodes: readonly unknown[], next: string | null) => ({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: { hasNextPage: next !== null, endCursor: next },
              nodes,
            },
          },
        },
      },
    });
    const pages: Record<string, unknown> = {
      "": response([node("r1", "A", "coderabbitai", "Bot")], "page-2"),
      "page-2": response(
        [node("r2", "B", "coderabbitai", "Bot"), node("r3", "B", "alice", "User")],
        null
      ),
    };
    const requests: string[] = [];
    const reader = new GhGitHubReader(async (argv) => {
      const value = (name: string) =>
        argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      const after = value("after") ?? "";
      requests.push(after);
      if (!(after in pages)) throw new Error(`unexpected page ${after}`);
      return selectedFields(value("query") ?? "", pages[after]);
    });
    expect(await resolveReviewPasses(reader, context, [])).toEqual([
      {
        author: "coderabbitai",
        passes: 2,
        latestPass: {
          reviewId: "r2",
          commitOid: "B",
          submittedAt: "2026-01-01T02:00:00Z",
        },
      },
    ]);
    expect(requests).toEqual(["", "page-2"]);
  });

  it("reads a bot author from the GraphQL type or a [bot] login", () => {
    const node = (id: string, author: unknown) => ({
      id,
      body: "summary",
      state: "COMMENTED",
      submittedAt: "2026-01-01T00:00:00Z",
      commit: { oid: "A" },
      author,
    });
    const page = parseReviewPage({
      data: {
        repository: {
          pullRequest: {
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                node("r1", { __typename: "Bot", login: "coderabbitai" }),
                node("r2", { __typename: "User", login: "alice" }),
                node("r3", { login: "acme-review[bot]" }),
                node("r4", null),
                {
                  ...node("r5", { __typename: "User", login: "bob" }),
                  state: "PENDING",
                  submittedAt: null,
                },
              ],
            },
          },
        },
      },
    });
    expect(
      page.reviews.map((review) => [review.id, review.authorLogin, review.authorIsBot])
    ).toEqual([
      ["r1", "coderabbitai", true],
      ["r2", "alice", false],
      ["r3", "acme-review[bot]", true],
      ["r4", null, false],
    ]);
    expect(page.endCursor).toBeNull();
  });
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
    const threads = await readReviewThreads(reader, context);
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
    const threads = buildReviewThreads(await readReviewThreads(reader, context));
    expect(threads.map((item) => item.id)).toEqual(["late"]);
  });

  it("stops after a single page when the cursor is exhausted", async () => {
    const reader = fakeReader({
      threadPages: [{ threads: [thread("only")], endCursor: null }],
    });
    expect(await readReviewThreads(reader, context)).toHaveLength(1);
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
    const threads = await readReviewThreads(reader, context);
    expect(countReviewPasses([], threads)).toMatchObject([{ author: "bugbot", passes: 2 }]);
  });

  it("drops resolved threads from later pages too", async () => {
    const reader = fakeReader({
      threadPages: [
        { threads: [thread("one")], endCursor: "next" },
        { threads: [thread("two", true)], endCursor: null },
      ],
    });
    expect(
      buildReviewThreads(await readReviewThreads(reader, context)).map(
        (item) => item.id
      )
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

  it("rejects a page that has a next page but no cursor, or a repeated cursor", async () => {
    const response = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: null },
              nodes: [],
            },
          },
        },
      },
    };
    expect(() => parseReviewThreadPage(response)).toThrow(WatcherQueryError);
    const looping = fakeReader({
      threadPages: [
        { threads: [thread("one")], endCursor: "next" },
        { threads: [thread("two")], endCursor: "next" },
      ],
    });
    await expect(readReviewThreads(looping, context)).rejects.toBeInstanceOf(
      WatcherQueryError
    );
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

  it("orders every child of one base by number, whatever order GitHub lists them in", () => {
    const ordered = orderStack(context, [
      { number: parsePrNumber(45), headRefName: "sibling-b", baseRefName: "feature" },
      { number: context.number, headRefName: "feature", baseRefName: "main" },
      { number: parsePrNumber(44), headRefName: "sibling-a", baseRefName: "feature" },
      { number: parsePrNumber(43), headRefName: "sibling-c", baseRefName: "feature" },
    ]);
    expect(ordered.map((item) => Number(item.number))).toEqual([42, 43, 44, 45]);
  });
});
