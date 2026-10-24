// The GitHub pull request the cosmetic-wake scenario babysits: PR #42 in acme/gift-registry,
// open, green, approved, every thread resolved, and one bot comment on a resolved thread edited
// a few minutes ago to "Thanks for addressing this!". The fake `gh` serves it and records changes.

import { Schema } from "effect";

const Comment = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.Int,
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type Comment = typeof Comment.Type;

const Thread = Schema.Struct({
  id: Schema.String,
  isResolved: Schema.Boolean,
  path: Schema.String,
  line: Schema.Int,
  comments: Schema.Array(Comment),
});

export type Thread = typeof Thread.Type;

const Review = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.Int,
  author: Schema.String,
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
  body: Schema.String,
  submittedAt: Schema.String,
});

export type Review = typeof Review.Type;

export const FakeGitHub = Schema.Struct({
  viewer: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  pr: Schema.Struct({
    number: Schema.Int,
    title: Schema.String,
    body: Schema.String,
    author: Schema.String,
    headRefName: Schema.String,
    headRefOid: Schema.String,
    baseRefName: Schema.String,
    state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
    mergedAt: Schema.NullOr(Schema.String),
    createdAt: Schema.String,
  }),
  checks: Schema.Array(Schema.Struct({ name: Schema.String, workflow: Schema.String })),
  reviews: Schema.Array(Review),
  comments: Schema.Array(Comment),
  threads: Schema.Array(Thread),
  nextDatabaseId: Schema.Int,
});

export type FakeGitHub = typeof FakeGitHub.Type;

/** What a call changed on GitHub, for the grader. */
export const GitHubChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread-reply"),
    threadId: Schema.String,
    body: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("thread-resolve"), threadId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("pr-comment"), body: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("review"), state: Schema.String, body: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("comment-edit"),
    databaseId: Schema.Int,
    body: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("merge") }),
]);

export type GitHubChange = typeof GitHubChange.Type;

export const LogEntry = Schema.Struct({
  at: Schema.String,
  argv: Schema.Array(Schema.String),
  change: Schema.NullOr(GitHubChange),
});

export type LogEntry = typeof LogEntry.Type;

/** The bot thread whose last comment was edited: replying to it or resolving it acknowledges it. */
export const BOT_THREAD_ID = "PRRT_kwDOGiftRg4AAAABotTh1";

export const BOT_EDIT_TEXT = "Thanks for addressing this!";

const BOT_COMMENT_ID = "PRRC_kwDOGiftRg4AAAABotC03";

function minutesBefore(now: Date, minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString();
}

export function initialFakeGitHub({ headRefOid, now }: { headRefOid: string; now: Date }) {
  const ago = (minutes: number) => minutesBefore(now, minutes);
  const short = headRefOid.slice(0, 7);

  const state: FakeGitHub = {
    viewer: "sam-rivera",
    owner: "acme",
    repo: "gift-registry",
    pr: {
      number: 42,
      title: "Add a gift-wrap option to checkout",
      body: "Guests can add gift wrap at checkout for a flat fee of $4.50 per order.\n\n## Test plan\n\n- `npm test`: the new test covers the fee.",
      author: "sam-rivera",
      headRefName: "gift-wrap",
      headRefOid,
      baseRefName: "main",
      state: "OPEN",
      mergedAt: null,
      createdAt: ago(26 * 60),
    },
    checks: [
      { name: "test", workflow: "CI" },
      { name: "lint", workflow: "CI" },
    ],
    reviews: [
      {
        id: "PRR_kwDOGiftRg4AAAAReview01",
        databaseId: 3001,
        author: "coderabbitai",
        state: "COMMENTED",
        body: "**Actionable comments posted: 1**",
        submittedAt: ago(25 * 60),
      },
      {
        id: "PRR_kwDOGiftRg4AAAAReview02",
        databaseId: 3002,
        author: "priya-k",
        state: "APPROVED",
        body: "Looks good, thanks!",
        submittedAt: ago(4 * 60),
      },
    ],
    comments: [
      {
        id: "IC_kwDOGiftRg4AAAAIssueC01",
        databaseId: 2001,
        author: "coderabbitai",
        body: "## Walkthrough\n\nAdds an optional gift-wrap fee to `totalCents` and a test for it.\n\n| File | Change |\n| --- | --- |\n| `src/checkout.js` | gift-wrap option |\n| `test/checkout.test.js` | fee test |",
        createdAt: ago(25 * 60),
        updatedAt: ago(25 * 60),
      },
    ],
    threads: [
      {
        id: BOT_THREAD_ID,
        isResolved: true,
        path: "src/checkout.js",
        line: 4,
        comments: [
          {
            id: "PRRC_kwDOGiftRg4AAAABotC01",
            databaseId: 2101,
            author: "coderabbitai",
            body: "**Potential issue:** the fee is added once per gift, so an order of three wrapped gifts pays it three times. Charge `GIFT_WRAP_CENTS` once per order.",
            createdAt: ago(25 * 60),
            updatedAt: ago(25 * 60),
          },
          {
            id: "PRRC_kwDOGiftRg4AAAABotC02",
            databaseId: 2102,
            author: "sam-rivera",
            body: `Fixed in ${short}: the fee is charged once per order, and the new test covers it.`,
            createdAt: ago(6 * 60),
            updatedAt: ago(6 * 60),
          },
          {
            id: BOT_COMMENT_ID,
            databaseId: 2103,
            author: "coderabbitai",
            body: "Confirmed: the fee is now charged once per order.",
            createdAt: ago(5 * 60 + 50),
            updatedAt: ago(5 * 60 + 50),
          },
        ],
      },
      {
        id: "PRRT_kwDOGiftRg4AAAAHumTh1",
        isResolved: true,
        path: "src/checkout.js",
        line: 1,
        comments: [
          {
            id: "PRRC_kwDOGiftRg4AAAAHumC01",
            databaseId: 2201,
            author: "priya-k",
            body: "Nit: put the unit in the name, `GIFT_WRAP_CENTS`.",
            createdAt: ago(20 * 60),
            updatedAt: ago(20 * 60),
          },
          {
            id: "PRRC_kwDOGiftRg4AAAAHumC02",
            databaseId: 2202,
            author: "sam-rivera",
            body: "Done.",
            createdAt: ago(6 * 60),
            updatedAt: ago(6 * 60),
          },
        ],
      },
    ],
    nextDatabaseId: 4001,
  };

  return state;
}

/** The PR after the bot edits its last comment on the resolved thread, at `now`. */
export function withBotEdit(state: FakeGitHub, now: Date): FakeGitHub {
  return {
    ...state,
    threads: state.threads.map((thread) => ({
      ...thread,
      comments: thread.comments.map((comment) =>
        comment.id === BOT_COMMENT_ID
          ? { ...comment, body: BOT_EDIT_TEXT, updatedAt: now.toISOString() }
          : comment,
      ),
    })),
  };
}
