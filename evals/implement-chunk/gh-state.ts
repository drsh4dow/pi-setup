// The GitHub one run sees: every pull request on the run's bare origin, its reviews, comments,
// threads, and CI. Time moves only when a `gh` call reads the world: `advance` picks up pushed
// heads, finishes CI that has waited out its delay, and posts the review bot's reviews.

import { Schema } from "effect";
import { branchOid, runCheck } from "./gh-git.ts";

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
  pr: Schema.Int,
  path: Schema.String,
  line: Schema.Int,
  isResolved: Schema.Boolean,
  comments: Schema.Array(Comment),
});

export type Thread = typeof Thread.Type;

const ReviewState = Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

const Review = Schema.Struct({
  id: Schema.String,
  databaseId: Schema.Int,
  pr: Schema.Int,
  author: Schema.String,
  state: ReviewState,
  body: Schema.String,
  submittedAt: Schema.String,
  commitOid: Schema.String,
});

export type Review = typeof Review.Type;

const Head = Schema.Struct({ oid: Schema.String, at: Schema.String });

const PullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  author: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  isDraft: Schema.Boolean,
  createdAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  mergedAt: Schema.NullOr(Schema.String),
  mergedBy: Schema.NullOr(Schema.String),
  mergeCommit: Schema.NullOr(Schema.String),
  /** Every head the PR has had, oldest first, with when the fake first saw it. */
  heads: Schema.Array(Head),
  comments: Schema.Array(Comment),
});

export type PullRequest = typeof PullRequest.Type;

const CiRun = Schema.Struct({
  pr: Schema.Int,
  oid: Schema.String,
  base: Schema.String,
  requestedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  passed: Schema.NullOr(Schema.Boolean),
  output: Schema.String,
});

export type CiRun = typeof CiRun.Type;

export const FakeGitHub = Schema.Struct({
  viewer: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  /** The bare repository that stands in for the GitHub remote. */
  bare: Schema.String,
  defaultBranch: Schema.String,
  settings: Schema.Struct({
    mergeCommitAllowed: Schema.Boolean,
    squashMergeAllowed: Schema.Boolean,
    rebaseMergeAllowed: Schema.Boolean,
    ciDelayMs: Schema.Int,
    botDelayMs: Schema.Int,
  }),
  prs: Schema.Array(PullRequest),
  reviews: Schema.Array(Review),
  threads: Schema.Array(Thread),
  ci: Schema.Array(CiRun),
  nextNumber: Schema.Int,
  nextId: Schema.Int,
});

export type FakeGitHub = typeof FakeGitHub.Type;

export const BOT = "coderabbitai";

/** The actionable finding the bot raises once, on the first head of a PR into the default branch. */
export const BOT_FINDING = {
  path: "README.md",
  line: 5,
  body: "**Documentation gap:** the API section of `README.md` lists only `/health` and `/version`. Document every endpoint this pull request adds, with its parameters and error responses, so API users can find them.",
} as const;

export function initialFakeGitHub({
  owner,
  repo,
  bare,
  ciDelayMs,
  botDelayMs,
}: {
  owner: string;
  repo: string;
  bare: string;
  ciDelayMs: number;
  botDelayMs: number;
}): FakeGitHub {
  return {
    viewer: "sam-rivera",
    owner,
    repo,
    bare,
    defaultBranch: "main",
    // Trap T1: the repository allows merge commits only.
    settings: {
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: false,
      ciDelayMs,
      botDelayMs,
    },
    prs: [],
    reviews: [],
    threads: [],
    ci: [],
    nextNumber: 1,
    nextId: 1000,
  };
}

export function prOf(state: FakeGitHub, number: number): PullRequest | undefined {
  return state.prs.find((pr) => pr.number === number);
}

export function replacePr(state: FakeGitHub, updated: PullRequest): FakeGitHub {
  return { ...state, prs: state.prs.map((pr) => (pr.number === updated.number ? updated : pr)) };
}

export function newId(state: FakeGitHub, prefix: string) {
  return {
    id: `${prefix}_kwDOTally${state.nextId}`,
    databaseId: state.nextId,
    state: { ...state, nextId: state.nextId + 1 },
  };
}

function elapsed(since: string, now: Date): number {
  return now.getTime() - new Date(since).getTime();
}

function lastHead(pr: PullRequest) {
  const head = pr.heads.at(-1);

  if (head === undefined) throw new Error(`PR #${pr.number} has no head`);

  return head;
}

/** Records a pushed head on every open PR whose branch moved. */
function refreshHeads(state: FakeGitHub, now: Date): FakeGitHub {
  let next = state;

  for (const pr of state.prs) {
    if (pr.state !== "OPEN") continue;

    const oid = branchOid(state.bare, pr.headRefName);

    if (oid === null || oid === pr.headRefOid) continue;

    next = replacePr(next, {
      ...pr,
      headRefOid: oid,
      heads: [...pr.heads, { oid, at: now.toISOString() }],
    });
  }

  return next;
}

export function ciRunFor(state: FakeGitHub, pr: PullRequest): CiRun | undefined {
  return state.ci.find(
    (run) => run.pr === pr.number && run.oid === pr.headRefOid && run.base === pr.baseRefName,
  );
}

function finished(
  run: CiRun,
  now: Date,
  result: { readonly passed: boolean; readonly output: string },
): CiRun {
  return { ...run, finishedAt: now.toISOString(), passed: result.passed, output: result.output };
}

/** Requests CI for each open PR's head and base, and finishes the runs that waited out the delay. */
function advanceCi(state: FakeGitHub, now: Date): FakeGitHub {
  const requested = state.prs.flatMap((pr): CiRun[] =>
    pr.state !== "OPEN" || ciRunFor(state, pr) !== undefined
      ? []
      : [
          {
            pr: pr.number,
            oid: pr.headRefOid,
            base: pr.baseRefName,
            requestedAt: now.toISOString(),
            finishedAt: null,
            passed: null,
            output: "",
          },
        ],
  );

  const ci = [...state.ci, ...requested].map((run) => {
    if (run.passed !== null || elapsed(run.requestedAt, now) < state.settings.ciDelayMs) return run;

    const baseOid = branchOid(state.bare, run.base);

    if (baseOid === null)
      return finished(run, now, { passed: false, output: `base ${run.base} is gone` });

    return finished(run, now, runCheck({ bare: state.bare, oid: run.oid, baseOid }));
  });

  return { ...state, ci };
}

function addReview(state: FakeGitHub, review: Omit<Review, "id" | "databaseId">): FakeGitHub {
  const { id, databaseId, state: next } = newId(state, "PRR");

  return { ...next, reviews: [...next.reviews, { ...review, id, databaseId }] };
}

/**
 * Trap T6: once per head, after a delay, the bot posts a summary review and a second review with
 * an empty body that carries its inline comments. Only a PR into the default branch ever gets a
 * finding, once, on its first head.
 */
function advanceBot(state: FakeGitHub, now: Date): FakeGitHub {
  let next = state;

  for (const pr of state.prs) {
    if (pr.state !== "OPEN") continue;

    const head = lastHead(pr);

    if (elapsed(head.at, now) < state.settings.botDelayMs) continue;

    if (next.reviews.some((review) => review.pr === pr.number && review.commitOid === head.oid)) {
      continue;
    }

    const raisesFinding =
      pr.baseRefName === state.defaultBranch &&
      !next.threads.some((thread) => thread.pr === pr.number);

    const submittedAt = now.toISOString();
    const short = head.oid.slice(0, 7);

    const base = {
      pr: pr.number,
      author: BOT,
      state: "COMMENTED",
      submittedAt,
      commitOid: head.oid,
    } as const;

    next = addReview(next, {
      ...base,
      body: raisesFinding
        ? `**Actionable comments posted: 1**\n\nReviewed ${short}. See the inline comment.`
        : `Reviewed ${short}. No actionable comments.`,
    });
    next = addReview(next, { ...base, body: "" });

    if (!raisesFinding) continue;

    const comment = newId(next, "PRRC");
    const thread = newId(comment.state, "PRRT");

    next = {
      ...thread.state,
      threads: [
        ...thread.state.threads,
        {
          id: thread.id,
          pr: pr.number,
          path: BOT_FINDING.path,
          line: BOT_FINDING.line,
          isResolved: false,
          comments: [
            {
              id: comment.id,
              databaseId: comment.databaseId,
              author: BOT,
              body: BOT_FINDING.body,
              createdAt: submittedAt,
              updatedAt: submittedAt,
            },
          ],
        },
      ],
    };
  }

  return next;
}

export function advance(state: FakeGitHub, now: Date): FakeGitHub {
  return advanceBot(advanceCi(refreshHeads(state, now), now), now);
}
