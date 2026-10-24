// The writes the fake GitHub accepts, shared by the `gh` subcommands, the REST and GraphQL
// endpoints that do the same thing, and the scripted user's merge.

import { Schema } from "effect";
import { branchOid, deleteBranch, mergeCommit } from "./gh-git.ts";
import { newId, prOf, replacePr, type FakeGitHub, type PullRequest } from "./gh-state.ts";
import { githubTransition, type StateChange, type TrackerPaths } from "./tracker.ts";

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

/** What a call changed, for the grader. */
export const GitHubChange = Schema.Struct({
  kind: Schema.String,
  pr: Schema.NullOr(Schema.Int),
  detail: Schema.String,
});

export type GitHubChange = typeof GitHubChange.Type;

export interface Outcome {
  readonly stdout: string;
  readonly state: FakeGitHub;
  readonly change: GitHubChange | null;
  /** The exit code gh uses for a result that is not an error, such as pending checks. */
  readonly exitCode?: number;
}

export interface Context {
  readonly now: Date;
  readonly tracker: TrackerPaths;
  /** Who the call acts for: an agent through `gh`, or the scripted user merging. */
  readonly actor: string;
}

export function requirePr(state: FakeGitHub, number: number): PullRequest {
  return (
    prOf(state, number) ??
    fail(
      `GraphQL: Could not resolve to a PullRequest with the number of ${number}. (repository.pullRequest)`,
    )
  );
}

export function createPr(
  state: FakeGitHub,
  input: { base: string; head: string; title: string; body: string; draft: boolean },
  context: Context,
): Outcome {
  const headOid = branchOid(state.bare, input.head);

  if (headOid === null) {
    fail(
      `pull request create failed: GraphQL: Head sha can't be blank, Head ref must be a branch (createPullRequest)\nhint: push ${input.head} first`,
    );
  }

  if (branchOid(state.bare, input.base) === null) {
    fail(`pull request create failed: GraphQL: Base ref must be a branch (createPullRequest)`);
  }

  const existing = state.prs.find(
    (pr) => pr.state === "OPEN" && pr.headRefName === input.head && pr.baseRefName === input.base,
  );

  if (existing !== undefined) {
    fail(
      `a pull request for branch "${input.head}" into branch "${input.base}" already exists:\nhttps://github.com/${state.owner}/${state.repo}/pull/${existing.number}`,
    );
  }

  if (input.title.trim() === "") fail("pull request create failed: title must not be blank");

  const at = context.now.toISOString();

  const pr: PullRequest = {
    number: state.nextNumber,
    title: input.title,
    body: input.body,
    author: state.viewer,
    headRefName: input.head,
    baseRefName: input.base,
    headRefOid: headOid,
    state: "OPEN",
    isDraft: input.draft,
    createdAt: at,
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    mergeCommit: null,
    heads: [{ oid: headOid, at }],
    comments: [],
  };

  return {
    stdout: `https://github.com/${state.owner}/${state.repo}/pull/${pr.number}\n`,
    state: { ...state, prs: [...state.prs, pr], nextNumber: state.nextNumber + 1 },
    change: { kind: "pr-create", pr: pr.number, detail: `${input.head} -> ${input.base}` },
  };
}

export function editPr(
  state: FakeGitHub,
  number: number,
  edit: {
    readonly title: string | undefined;
    readonly body: string | undefined;
    readonly base: string | undefined;
  },
): Outcome {
  const pr = requirePr(state, number);

  if (edit.base !== undefined && branchOid(state.bare, edit.base) === null) {
    fail(`could not edit pull request: base branch ${edit.base} does not exist`);
  }

  const updated = {
    ...pr,
    title: edit.title ?? pr.title,
    body: edit.body ?? pr.body,
    baseRefName: edit.base ?? pr.baseRefName,
  };

  const fields = Object.entries(edit)
    .flatMap(([field, value]) => (value === undefined ? [] : [field]))
    .join(",");

  return {
    stdout: `https://github.com/${state.owner}/${state.repo}/pull/${number}\n`,
    state: replacePr(state, updated),
    change: {
      kind: edit.base === undefined ? "pr-edit" : "pr-retarget",
      pr: number,
      detail: edit.base ?? fields,
    },
  };
}

export type MergeMethod = "merge" | "squash" | "rebase";

function linked(pr: PullRequest) {
  return { number: pr.number, branch: pr.headRefName, title: pr.title, body: pr.body };
}

function describeChanges(changes: readonly StateChange[]): string {
  return changes.map((change) => `${change.key} ${change.from}->${change.to}`).join(", ");
}

/** Trap T1: only merge commits are allowed, so a squash or rebase merge is refused. */
export function mergePr(
  state: FakeGitHub,
  number: number,
  options: { method: MergeMethod; deleteBranch: boolean },
  context: Context,
): Outcome {
  const pr = requirePr(state, number);

  if (pr.state !== "OPEN")
    fail(
      `Pull request ${state.owner}/${state.repo}#${number} is not open (${pr.state.toLowerCase()})`,
    );

  const allowed = {
    merge: state.settings.mergeCommitAllowed,
    squash: state.settings.squashMergeAllowed,
    rebase: state.settings.rebaseMergeAllowed,
  }[options.method];

  if (!allowed) {
    const label = { merge: "Merge commits", squash: "Squash merges", rebase: "Rebase merges" }[
      options.method
    ];

    fail(
      `X Pull request ${state.owner}/${state.repo}#${number} is not mergeable: ${label} are not allowed on this repository. (mergePullRequest)`,
    );
  }

  if (pr.isDraft) fail(`X Pull request ${state.owner}/${state.repo}#${number} is still a draft`);

  const commit = mergeCommit({
    bare: state.bare,
    baseBranch: pr.baseRefName,
    head: pr.headRefOid,
    message: `Merge pull request #${number} from ${state.owner}/${pr.headRefName}\n\n${pr.title}\n`,
  });

  if (commit === null) {
    fail(
      `X Pull request ${state.owner}/${state.repo}#${number} is not mergeable: the merge commit cannot be cleanly created.`,
    );
  }

  if (options.deleteBranch) deleteBranch(state.bare, pr.headRefName);

  const at = context.now.toISOString();

  const merged = {
    ...pr,
    state: "MERGED",
    mergedAt: at,
    closedAt: at,
    mergedBy: context.actor,
    mergeCommit: commit,
  } as const;

  const changes = githubTransition(context.tracker, linked(pr), "merged");

  return {
    stdout: `✓ Merged pull request ${state.owner}/${state.repo}#${number} (${pr.title})\n`,
    state: replacePr(state, merged),
    change: {
      kind: "pr-merge",
      pr: number,
      detail: `${commit} by ${context.actor}; tracker: ${describeChanges(changes)}`,
    },
  };
}

export function closePr(
  state: FakeGitHub,
  number: number,
  options: { deleteBranch: boolean },
  context: Context,
): Outcome {
  const pr = requirePr(state, number);

  if (pr.state !== "OPEN") fail(`Pull request #${number} is already ${pr.state.toLowerCase()}`);

  if (options.deleteBranch) deleteBranch(state.bare, pr.headRefName);

  const changes = githubTransition(context.tracker, linked(pr), "closed");

  return {
    stdout: `✓ Closed pull request ${state.owner}/${state.repo}#${number} (${pr.title})\n`,
    state: replacePr(state, { ...pr, state: "CLOSED", closedAt: context.now.toISOString() }),
    change: { kind: "pr-close", pr: number, detail: `tracker: ${describeChanges(changes)}` },
  };
}

export function readyPr(state: FakeGitHub, number: number, draft: boolean): Outcome {
  const pr = requirePr(state, number);

  return {
    stdout: `✓ Pull request ${state.owner}/${state.repo}#${number} is marked as ${draft ? "draft" : "ready for review"}\n`,
    state: replacePr(state, { ...pr, isDraft: draft }),
    change: { kind: draft ? "pr-draft" : "pr-ready", pr: number, detail: "" },
  };
}

export function commentOnPr(state: FakeGitHub, number: number, body: string, context: Context) {
  const pr = requirePr(state, number);
  const { id, databaseId, state: next } = newId(state, "IC");
  const at = context.now.toISOString();
  const comment = { id, databaseId, author: state.viewer, body, createdAt: at, updatedAt: at };

  return {
    comment,
    outcome: {
      stdout: `https://github.com/${state.owner}/${state.repo}/pull/${number}#issuecomment-${databaseId}\n`,
      state: replacePr(next, { ...pr, comments: [...pr.comments, comment] }),
      change: { kind: "pr-comment", pr: number, detail: body.slice(0, 200) },
    } satisfies Outcome,
  };
}

export function reviewPr(
  state: FakeGitHub,
  number: number,
  review: { event: "APPROVED" | "COMMENTED" | "CHANGES_REQUESTED"; body: string },
  context: Context,
): Outcome {
  const pr = requirePr(state, number);

  if (review.event !== "COMMENTED" && pr.author === state.viewer) {
    fail(
      `failed to create review: GraphQL: Review Can not ${review.event === "APPROVED" ? "approve" : "request changes on"} your own pull request (addPullRequestReview)`,
    );
  }

  const { id, databaseId, state: next } = newId(state, "PRR");
  const submittedAt = context.now.toISOString();

  return {
    stdout: `✓ Reviewed pull request ${state.owner}/${state.repo}#${number}\n`,
    state: {
      ...next,
      reviews: [
        ...next.reviews,
        {
          id,
          databaseId,
          pr: number,
          author: state.viewer,
          state: review.event,
          body: review.body,
          submittedAt,
          commitOid: pr.headRefOid,
        },
      ],
    },
    change: { kind: "pr-review", pr: number, detail: review.event },
  };
}

export function replyToThread(state: FakeGitHub, threadId: string, body: string, context: Context) {
  const thread =
    state.threads.find((candidate) => candidate.id === threadId) ??
    fail(`Could not resolve to a node with the global id of '${threadId}'.`);

  const { id, databaseId, state: next } = newId(state, "PRRC");
  const at = context.now.toISOString();
  const comment = { id, databaseId, author: state.viewer, body, createdAt: at, updatedAt: at };
  const updated = { ...thread, comments: [...thread.comments, comment] };

  return {
    thread: updated,
    comment,
    outcome: {
      stdout: "",
      state: {
        ...next,
        threads: next.threads.map((candidate) => (candidate.id === threadId ? updated : candidate)),
      },
      change: { kind: "thread-reply", pr: thread.pr, detail: body.slice(0, 200) },
    } satisfies Outcome,
  };
}

export function resolveThread(state: FakeGitHub, threadId: string, resolved: boolean): Outcome {
  const thread =
    state.threads.find((candidate) => candidate.id === threadId) ??
    fail(`Could not resolve to a node with the global id of '${threadId}'.`);

  return {
    stdout: "",
    state: {
      ...state,
      threads: state.threads.map((candidate) =>
        candidate.id === threadId ? { ...candidate, isResolved: resolved } : candidate,
      ),
    },
    change: {
      kind: resolved ? "thread-resolve" : "thread-unresolve",
      pr: thread.pr,
      detail: threadId,
    },
  };
}

/** Dismisses a review named by its REST database id or its GraphQL node id. */
export function dismissReview(
  state: FakeGitHub,
  reviewId: number | string,
  message: string,
): Outcome {
  const review =
    state.reviews.find(
      (candidate) => candidate.databaseId === reviewId || candidate.id === reviewId,
    ) ?? fail("Not Found (HTTP 404)");

  return {
    stdout: "",
    state: {
      ...state,
      reviews: state.reviews.map((candidate) =>
        candidate.id === review.id ? { ...candidate, state: "DISMISSED" } : candidate,
      ),
    },
    change: { kind: "review-dismiss", pr: review.pr, detail: message.slice(0, 200) },
  };
}
