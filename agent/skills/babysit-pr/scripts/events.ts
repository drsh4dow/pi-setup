import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import {
  commentSchema,
  prSchema,
  reviewSchema,
  parseJson,
  type Comment,
  type PullRequest,
  type SnapshotInput,
} from "./contracts.ts";

const VERSION = 1;

const nonEmptyString = Type.String({ minLength: 1 });

const eventContentSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("issue-comment"),
    payload: Type.Object({ comment: commentSchema }),
  }),
  Type.Object({
    kind: Type.Literal("review-comment"),
    payload: Type.Object({ comment: commentSchema }),
  }),
  Type.Object({ kind: Type.Literal("review"), payload: Type.Object({ review: reviewSchema }) }),
  Type.Object({
    kind: Type.Literal("check-failed"),
    payload: Type.Object({
      check: Type.Object({
        name: nonEmptyString,
        bucket: Type.Union([Type.Literal("fail"), Type.Literal("cancel")]),
        state: nonEmptyString,
        link: Type.String(),
      }),
    }),
  }),
  Type.Object({
    kind: Type.Literal("merge-conflict"),
    payload: Type.Record(Type.String(), Type.Never()),
  }),
  Type.Object({
    kind: Type.Literal("behind-target"),
    payload: Type.Object({ behindBy: Type.Integer({ minimum: 1 }) }),
  }),
  Type.Object({
    kind: Type.Literal("review-thread-reopened"),
    payload: Type.Object({ threadId: nonEmptyString }),
  }),
]);

export const eventSchema = Type.Intersect([
  Type.Object({
    version: Type.Literal(VERSION),
    id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    marker: Type.String(),
    key: nonEmptyString,
    observedAt: Type.String(),
    pr: Type.Pick(prSchema, [
      "number",
      "url",
      "baseRefName",
      "headRefName",
      "baseRefOid",
      "headRefOid",
    ]),
  }),
  eventContentSchema,
]);

export type PrEvent = Static<typeof eventSchema>;

type EventContent = Static<typeof eventContentSchema>;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function compactTimestamp(value: string | null | undefined) {
  return (value ?? "unknown").replace(/[^0-9A-Za-z]/g, "");
}

function eventMarker(id: string) {
  return `<!-- pi-event:${id} -->`;
}

export function parseEvent(text: string): PrEvent {
  const event = parseJson(eventSchema, text);

  if (
    !Number.isFinite(Date.parse(event.observedAt)) ||
    event.id !== hash(event.key) ||
    event.marker !== eventMarker(event.id)
  ) {
    throw new Error("Invalid event timestamp or identity");
  }

  return event;
}

function makeEvent(
  pr: PullRequest,
  key: string,
  observedAt: string,
  content: EventContent,
): PrEvent {
  const id = hash(key);

  return {
    version: VERSION,
    id,
    marker: eventMarker(id),
    key,
    observedAt,
    pr: {
      number: pr.number,
      url: pr.url,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      baseRefOid: pr.baseRefOid,
      headRefOid: pr.headRefOid,
    },
    ...content,
  };
}

function trustedComment(comment: Comment, input: SnapshotInput) {
  const login = comment.user.login;

  return (
    input.trustedLogins.has(login) &&
    !(login === input.selfLogin && /(?:^|\r?\n)Written by Pi Agent\s*$/u.test(comment.body ?? ""))
  );
}

export function candidateEvents(input: SnapshotInput, observedAt: string): PrEvent[] {
  const { pr } = input;
  const events: PrEvent[] = [];

  for (const comment of input.issueComments) {
    if (!trustedComment(comment, input)) continue;
    const key = `issue-comment:${comment.id}:${compactTimestamp(comment.updated_at)}`;
    events.push(makeEvent(pr, key, observedAt, { kind: "issue-comment", payload: { comment } }));
  }

  for (const comment of input.reviewComments) {
    if (!trustedComment(comment, input) || !input.unresolvedReviewCommentIds.has(comment.id))
      continue;
    const key = `review-comment:${comment.id}:${compactTimestamp(comment.updated_at)}`;
    events.push(makeEvent(pr, key, observedAt, { kind: "review-comment", payload: { comment } }));
  }

  for (const review of input.reviews) {
    if (!trustedComment(review, input)) continue;
    const state = review.state.toUpperCase();
    const body = review.body?.trim() ?? "";

    if (!body && state !== "CHANGES_REQUESTED") continue;
    const key = `review:${review.id}:${compactTimestamp(review.submitted_at)}:${state}:${hash(body)}`;
    events.push(makeEvent(pr, key, observedAt, { kind: "review", payload: { review } }));
  }

  for (const check of input.checks) {
    const { bucket } = check;

    if (bucket !== "fail" && bucket !== "cancel") continue;
    const key = `check:${pr.headRefOid}:${check.name}:${compactTimestamp(check.completedAt)}:${check.state}:${check.link}`;
    events.push(
      makeEvent(pr, key, observedAt, {
        kind: "check-failed",
        payload: { check: { ...check, bucket } },
      }),
    );
  }

  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    const key = `merge-conflict:${pr.baseRefOid}:${pr.headRefOid}`;
    events.push(makeEvent(pr, key, observedAt, { kind: "merge-conflict", payload: {} }));
  }

  if (input.comparison.behind_by > 0) {
    const key = `behind-target:${pr.baseRefOid}:${pr.headRefOid}`;
    events.push(
      makeEvent(pr, key, observedAt, {
        kind: "behind-target",
        payload: { behindBy: input.comparison.behind_by },
      }),
    );
  }

  for (const [threadId, resolved] of input.threadStates) {
    if (input.previousThreadStates?.[threadId] === true && !resolved) {
      const key = `review-thread-reopened:${threadId}:${pr.headRefOid}:${compactTimestamp(observedAt)}`;
      events.push(
        makeEvent(pr, key, observedAt, { kind: "review-thread-reopened", payload: { threadId } }),
      );
    }
  }

  return events;
}

export function eventSubject(event: PrEvent) {
  switch (event.kind) {
    case "issue-comment":
      return `issue-comment:${event.payload.comment.id}`;
    case "review-comment":
      return `review-comment:${event.payload.comment.id}`;
    case "review":
      return `review:${event.payload.review.id}`;
    case "check-failed":
    case "merge-conflict":
    case "behind-target":
    case "review-thread-reopened":
      return event.key;
    default: {
      const unexpected: never = event;
      throw new Error(`Unexpected event: ${JSON.stringify(unexpected)}`);
    }
  }
}
