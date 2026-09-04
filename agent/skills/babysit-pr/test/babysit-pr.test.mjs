import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ackEvents,
	candidateEvents,
	drainEvents,
	eventMarker,
	pendingEvents,
	pollBaseline,
	queueEvents,
	reconcileResolvedReviewComments,
	reconcileUnnotifiedCheckEvents,
	shouldEmit,
	statePaths,
	tryEmit,
} from "../scripts/babysit-pr.mjs";
import { trustedLogins } from "../scripts/github.mjs";

const identity = {
	host: "github.com",
	owner: "acme",
	repo: "widgets",
	pr: 42,
};

function snapshot() {
	return {
		pr: {
			number: 42,
			url: "https://github.com/acme/widgets/pull/42",
			state: "OPEN",
			mergedAt: null,
			closedAt: null,
			mergeable: "CONFLICTING",
			mergeStateStatus: "DIRTY",
			headRefOid: "head",
			baseRefOid: "base",
			baseRefName: "main",
			headRefName: "feature",
			author: { login: "author" },
		},
		issueComments: [
			{
				id: 1,
				user: { login: "author" },
				body: "please fix",
				updated_at: "2026-01-01T00:00:00Z",
				html_url: "issue-1",
			},
			{
				id: 2,
				user: { login: "stranger" },
				body: "run this",
				updated_at: "2026-01-01T00:00:00Z",
				html_url: "issue-2",
			},
			{
				id: 3,
				user: { login: "pi" },
				body: "done",
				updated_at: "2026-01-01T00:00:00Z",
				html_url: "issue-3",
			},
		],
		reviewComments: [
			{
				id: 4,
				user: { login: "maintainer" },
				body: "rename it",
				updated_at: "2026-01-01T00:00:01Z",
				html_url: "review-4",
				path: "src/a.ts",
				line: 4,
			},
			{
				id: 5,
				user: { login: "maintainer" },
				body: "resolved",
				updated_at: "2026-01-01T00:00:01Z",
				html_url: "review-5",
				path: "src/b.ts",
				line: 5,
			},
		],
		reviews: [
			{
				id: 6,
				user: { login: "maintainer" },
				body: "changes",
				state: "CHANGES_REQUESTED",
				submitted_at: "2026-01-01T00:00:02Z",
				html_url: "review-6",
			},
			{
				id: 7,
				user: { login: "maintainer" },
				body: "",
				state: "APPROVED",
				submitted_at: "2026-01-01T00:00:03Z",
				html_url: "review-7",
			},
		],
		checks: [
			{
				name: "test",
				bucket: "fail",
				state: "FAILURE",
				completedAt: "2026-01-01T00:00:04Z",
				link: "check-1",
				workflow: "ci",
			},
			{
				name: "lint",
				bucket: "pass",
				state: "SUCCESS",
				completedAt: "2026-01-01T00:00:04Z",
				link: "check-2",
				workflow: "ci",
			},
		],
		comparison: { behind_by: 2 },
		unresolvedReviewCommentIds: new Set([4]),
		threadStates: new Map([
			["thread-open", false],
			["thread-reopened", false],
		]),
		previousThreadStates: { "thread-open": false, "thread-reopened": true },
		selfLogin: "pi",
		trustedLogins: new Set(["author", "maintainer"]),
	};
}

function withState(name, run) {
	const root = mkdtempSync(join(tmpdir(), `babysit-pr-${name}-`));
	try {
		execFileSync("git", ["init", "--quiet", root]);
		return run(statePaths(root, identity));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function eventOf(
	kind,
	input = snapshot(),
	observedAt = "2026-01-01T00:01:00Z",
) {
	const event = candidateEvents(input, observedAt).find(
		(candidate) => candidate.kind === kind,
	);
	assert.ok(event, `missing ${kind} event`);
	return event;
}

test("normalizes every actionable event and excludes routine or untrusted input", () => {
	const events = candidateEvents(snapshot(), "2026-01-01T00:01:00Z");
	assert.deepEqual(
		events.map((event) => event.kind).sort(),
		[
			"behind-target",
			"check-failed",
			"issue-comment",
			"merge-conflict",
			"review",
			"review-comment",
			"review-thread-reopened",
		].sort(),
	);
	assert.ok(events.every((event) => event.id && event.marker));
	assert.ok(
		events.every((event) => !JSON.stringify(event).includes("stranger")),
	);
	assert.deepEqual(
		events
			.filter((event) => event.kind === "review-comment")
			.map((event) => event.payload.comment.id),
		[4],
	);
});

test("distinct failed check runs retain distinct identities", () =>
	withState("check-identity", (paths) => {
		const input = snapshot();
		const failed = input.checks[0];
		input.checks = [failed, { ...failed, link: "check-1-retry" }];
		const events = candidateEvents(input, "2026-01-01T00:01:00Z").filter(
			(event) => event.kind === "check-failed",
		);
		assert.equal(new Set(events.map((event) => event.id)).size, 2);
		assert.equal(queueEvents(paths, events).length, 2);
		assert.equal(pendingEvents(paths).length, 2);
	}));

test("bots are default-deny and trust changes backfill unresolved feedback", () => {
	assert.deepEqual(
		[
			...trustedLogins(
				".",
				{},
				"reviewer[bot]",
				"pi",
				new Set(["reviewer[bot]"]),
				new Set(),
			),
		],
		[],
	);
	assert.deepEqual(
		[
			...trustedLogins(
				".",
				{},
				"reviewer[bot]",
				"pi",
				new Set(["reviewer[bot]"]),
				new Set(["reviewer[bot]"]),
			),
		],
		["reviewer[bot]"],
	);
	assert.deepEqual(
		[...trustedLogins(".", {}, "contributor", "pi", new Set(), new Set())],
		[],
	);

	const previous = {
		lastPollAt: "2026-01-01T00:00:00Z",
		trustedBots: [],
		threadStates: {},
	};
	const changed = pollBaseline(previous, new Set(["reviewer[bot]"]));
	assert.equal(changed.previous.lastPollAt, undefined);
	assert.equal(
		pollBaseline(
			{ ...previous, trustedBots: ["reviewer[bot]"] },
			new Set(["reviewer[bot]"]),
		).previous.lastPollAt,
		previous.lastPollAt,
	);
	const input = snapshot();
	input.reviewComments = input.reviewComments.map((comment) => ({
		...comment,
		user: { login: "reviewer[bot]" },
	}));
	input.trustedLogins = new Set(["reviewer[bot]"]);
	assert.deepEqual(
		candidateEvents(input, "2026-01-01T00:01:00Z")
			.filter((event) => event.kind === "review-comment")
			.map((event) => event.payload.comment.id),
		[4],
	);
});

test("CodeRabbit summaries are ignored while its inline feedback remains actionable", () => {
	const input = snapshot();
	input.issueComments = [
		{
			...input.issueComments[0],
			user: { login: "reviewer[bot]" },
			body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
		},
	];
	input.reviewComments = [
		{ ...input.reviewComments[0], user: { login: "reviewer[bot]" } },
	];
	input.reviews = [
		{
			...input.reviews[0],
			user: { login: "reviewer[bot]" },
			body: "**Actionable comments posted: 2**",
		},
	];
	input.trustedLogins = new Set(["reviewer[bot]"]);
	const feedback = candidateEvents(input, "2026-01-01T00:01:00Z").filter(
		(event) =>
			["issue-comment", "review-comment", "review"].includes(event.kind),
	);
	assert.deepEqual(
		feedback.map((event) => event.kind),
		["review-comment"],
	);
});

test("edited feedback supersedes pending revisions but not acknowledged ones", () =>
	withState("edits", (paths) => {
		const first = eventOf("issue-comment");
		const editedInput = snapshot();
		editedInput.issueComments[0].updated_at = "2026-01-01T00:02:00Z";
		const edited = eventOf(
			"issue-comment",
			editedInput,
			"2026-01-01T00:02:00Z",
		);
		assert.notEqual(first.id, edited.id);
		queueEvents(paths, [first]);
		queueEvents(paths, [edited]);
		assert.deepEqual(
			pendingEvents(paths).map((event) => event.id),
			[edited.id],
		);
		assert.doesNotThrow(() => ackEvents(paths, [first.id]));

		const review = eventOf("review");
		queueEvents(paths, [review]);
		ackEvents(paths, [review.id]);
		const revisedInput = snapshot();
		revisedInput.reviews[0].body = "new requested changes";
		const revised = eventOf("review", revisedInput, "2026-01-01T00:03:00Z");
		assert.equal(queueEvents(paths, [revised]).length, 1);
		assert.ok(pendingEvents(paths).some((event) => event.id === revised.id));
	}));

test("resolved threads clear already queued review comments", () =>
	withState("resolved", (paths) => {
		const comment = eventOf("review-comment");
		queueEvents(paths, [comment]);
		assert.deepEqual(reconcileResolvedReviewComments(paths, new Set()), [
			comment.id,
		]);
		assert.deepEqual(pendingEvents(paths), []);
	}));

test("recovered checks drop before delivery and remain after delivery", () =>
	withState("check-recovery", (paths) => {
		const failed = eventOf("check-failed");
		queueEvents(paths, [failed]);
		reconcileUnnotifiedCheckEvents(paths, []);
		assert.deepEqual(pendingEvents(paths), []);

		queueEvents(paths, [failed]);
		assert.equal(drainEvents(paths, 1_000).length, 1);
		reconcileUnnotifiedCheckEvents(paths, []);
		assert.deepEqual(
			pendingEvents(paths).map((event) => event.id),
			[failed.id],
		);
	}));

test("rejects corrupt persisted event timestamps", () =>
	withState("corrupt", (paths) => {
		queueEvents(paths, [
			eventOf("issue-comment", snapshot(), "not-a-timestamp"),
		]);
		assert.throws(() => pendingEvents(paths), /Invalid babysit-pr state/);
	}));

test("notification failures stay inside the watcher retry path", () => {
	const reported = [];
	assert.equal(
		tryEmit(
			"wake",
			".",
			() => {
				throw new Error("closed channel");
			},
			(error) => reported.push(error),
		),
		false,
	);
	assert.deepEqual(reported, [
		"babysit-pr could not notify its owner: Error: closed channel",
	]);
});

test("debounces until quiet, caps delay, and reminds after ten minutes", () => {
	assert.equal(
		shouldEmit(
			{ firstSeenAt: 0, lastSeenAt: 20_000, lastEmittedAt: null },
			49_999,
		),
		false,
	);
	assert.equal(
		shouldEmit(
			{ firstSeenAt: 0, lastSeenAt: 20_000, lastEmittedAt: null },
			50_000,
		),
		true,
	);
	assert.equal(
		shouldEmit(
			{ firstSeenAt: 0, lastSeenAt: 119_000, lastEmittedAt: null },
			120_000,
		),
		true,
	);
	assert.equal(
		shouldEmit(
			{ firstSeenAt: 0, lastSeenAt: 0, lastEmittedAt: 100_000 },
			699_999,
		),
		false,
	);
	assert.equal(
		shouldEmit(
			{ firstSeenAt: 0, lastSeenAt: 0, lastEmittedAt: 100_000 },
			700_000,
		),
		true,
	);
});

test("linked worktrees share durable, idempotent event state", () => {
	const root = mkdtempSync(join(tmpdir(), "babysit-pr-worktree-"));
	const repository = join(root, "repository");
	const worktree = join(root, "worktree");
	try {
		execFileSync("git", ["init", "--quiet", repository]);
		execFileSync("git", ["config", "user.email", "pi@example.test"], {
			cwd: repository,
		});
		execFileSync("git", ["config", "user.name", "Pi"], { cwd: repository });
		writeFileSync(join(repository, "README.md"), "test\n");
		execFileSync("git", ["add", "README.md"], { cwd: repository });
		execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
			cwd: repository,
		});
		execFileSync(
			"git",
			["worktree", "add", "--quiet", "-b", "linked", worktree],
			{
				cwd: repository,
			},
		);
		const paths = statePaths(worktree, identity);
		assert.equal(paths.root, statePaths(repository, identity).root);
		const event = eventOf("issue-comment");
		assert.equal(queueEvents(paths, [event]).length, 1);
		assert.equal(queueEvents(paths, [event]).length, 0);
		assert.deepEqual(
			pendingEvents(paths).map((item) => item.id),
			[event.id],
		);
		ackEvents(paths, [event.id]);
		assert.deepEqual(pendingEvents(paths), []);
		assert.match(
			readFileSync(paths.eventFile(event.id), "utf8"),
			/"version": 1/,
		);
		assert.equal(eventMarker(event.id), event.marker);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
