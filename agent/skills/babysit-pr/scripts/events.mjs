import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

const VERSION = 1;
const nonEmptyString = Type.String({ minLength: 1 });
const commentSchema = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	user: Type.Object({ login: nonEmptyString }),
	body: Type.Union([Type.String(), Type.Null()]),
});
const payloads = {
	"issue-comment": Type.Object({ comment: commentSchema }),
	"review-comment": Type.Object({ comment: commentSchema }),
	review: Type.Object({
		review: Type.Intersect([
			commentSchema,
			Type.Object({ state: nonEmptyString }),
		]),
	}),
	"check-failed": Type.Object({
		check: Type.Object({
			name: nonEmptyString,
			bucket: Type.Union([Type.Literal("fail"), Type.Literal("cancel")]),
			state: nonEmptyString,
			link: Type.String(),
		}),
	}),
	"merge-conflict": Type.Object({}),
	"behind-target": Type.Object({ behindBy: Type.Integer({ minimum: 1 }) }),
	"review-thread-reopened": Type.Object({ threadId: nonEmptyString }),
};
const eventSchema = Type.Intersect([
	Type.Object({
		version: Type.Literal(VERSION),
		id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		marker: Type.String(),
		key: nonEmptyString,
		observedAt: Type.String(),
		pr: Type.Object({
			number: Type.Integer({ minimum: 1 }),
			url: nonEmptyString,
			baseRefName: nonEmptyString,
			headRefName: nonEmptyString,
			baseRefOid: nonEmptyString,
			headRefOid: nonEmptyString,
		}),
	}),
	Type.Union(
		Object.entries(payloads).map(([kind, payload]) =>
			Type.Object({ kind: Type.Literal(kind), payload }),
		),
	),
]);

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function compactTimestamp(value) {
	return String(value ?? "unknown").replace(/[^0-9A-Za-z]/g, "");
}

function eventMarker(id) {
	return `<!-- pi-event:${id} -->`;
}

export function validEvent(value) {
	return (
		Value.Check(eventSchema, value) &&
		Number.isFinite(Date.parse(value.observedAt)) &&
		value.id === hash(value.key) &&
		value.marker === eventMarker(value.id)
	);
}

function makeEvent(pr, kind, key, observedAt, payload) {
	const id = hash(key);
	return {
		version: VERSION,
		id,
		marker: eventMarker(id),
		kind,
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
		payload,
	};
}

function trustedComment(comment, input) {
	const login = comment?.user?.login;
	return (
		typeof login === "string" &&
		input.trustedLogins.has(login) &&
		!(
			login === input.selfLogin &&
			typeof comment.body === "string" &&
			/(?:^|\r?\n)Written by Pi Agent\s*$/u.test(comment.body)
		)
	);
}

export function candidateEvents(input, observedAt) {
	const { pr } = input;
	const events = [];
	for (const comment of input.issueComments) {
		if (!trustedComment(comment, input)) continue;
		const key = `issue-comment:${comment.id}:${compactTimestamp(comment.updated_at)}`;
		events.push(makeEvent(pr, "issue-comment", key, observedAt, { comment }));
	}
	for (const comment of input.reviewComments) {
		if (!trustedComment(comment, input)) continue;
		if (!input.unresolvedReviewCommentIds.has(comment.id)) continue;
		const key = `review-comment:${comment.id}:${compactTimestamp(comment.updated_at)}`;
		events.push(makeEvent(pr, "review-comment", key, observedAt, { comment }));
	}
	for (const review of input.reviews) {
		if (!trustedComment(review, input)) continue;
		const state = String(review.state ?? "").toUpperCase();
		const body = typeof review.body === "string" ? review.body.trim() : "";
		if (!body && state !== "CHANGES_REQUESTED") continue;
		const key = `review:${review.id}:${compactTimestamp(review.submitted_at)}:${state}:${hash(body)}`;
		events.push(makeEvent(pr, "review", key, observedAt, { review }));
	}
	for (const check of input.checks) {
		if (check.bucket !== "fail" && check.bucket !== "cancel") continue;
		const key = `check:${pr.headRefOid}:${check.name}:${compactTimestamp(check.completedAt)}:${check.state}:${check.link}`;
		events.push(makeEvent(pr, "check-failed", key, observedAt, { check }));
	}
	if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
		const key = `merge-conflict:${pr.baseRefOid}:${pr.headRefOid}`;
		events.push(makeEvent(pr, "merge-conflict", key, observedAt, {}));
	}
	if (input.comparison.behind_by > 0) {
		const key = `behind-target:${pr.baseRefOid}:${pr.headRefOid}`;
		events.push(
			makeEvent(pr, "behind-target", key, observedAt, {
				behindBy: input.comparison.behind_by,
			}),
		);
	}
	for (const [threadId, resolved] of input.threadStates) {
		if (input.previousThreadStates?.[threadId] === true && resolved === false) {
			const key = `review-thread-reopened:${threadId}:${pr.headRefOid}:${compactTimestamp(observedAt)}`;
			events.push(
				makeEvent(pr, "review-thread-reopened", key, observedAt, {
					threadId,
				}),
			);
		}
	}
	return events;
}

export function eventSubject(event) {
	switch (event.kind) {
		case "issue-comment":
			return `issue-comment:${event.payload.comment.id}`;
		case "review-comment":
			return `review-comment:${event.payload.comment.id}`;
		case "review":
			return `review:${event.payload.review.id}`;
		default:
			return event.key;
	}
}
