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

test("normalizes every wake-up class and excludes untrusted, resolved, and routine events", () => {
	const events = candidateEvents(snapshot(), "2026-01-01T00:01:00Z");
	assert.deepEqual(
		events
			.map((event) => event.kind)
			.sort((left, right) => left.localeCompare(right)),
		[
			"behind-target",
			"check-failed",
			"issue-comment",
			"merge-conflict",
			"review",
			"review-comment",
			"review-thread-reopened",
		].sort((left, right) => left.localeCompare(right)),
	);
	assert.ok(events.every((event) => event.id && event.marker));
	assert.ok(
		events.every((event) => !JSON.stringify(event).includes("stranger")),
	);
});

test("resolved review comments never become actionable events", () => {
	assert.deepEqual(
		candidateEvents(snapshot(), "2026-01-01T00:01:00Z")
			.filter((event) => event.kind === "review-comment")
			.map((event) => event.payload.comment.id),
		[4],
	);
});

test("bot authors remain untrusted unless explicitly allowlisted", () => {
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
});

test("a non-collaborator PR author remains untrusted", () => {
	assert.deepEqual(
		[...trustedLogins(".", {}, "contributor", "pi", new Set(), new Set())],
		[],
	);
});

test("a trusted-bot change forces a full reconciliation", () => {
	const previous = {
		lastPollAt: "2026-01-01T00:00:00Z",
		trustedBots: [],
		threadStates: {},
	};
	const changed = pollBaseline(previous, new Set(["reviewer[bot]"]));
	assert.equal(changed.previous.lastPollAt, undefined);
	assert.deepEqual(changed.configuredTrustedBots, ["reviewer[bot]"]);
	const unchanged = pollBaseline(
		{ ...previous, trustedBots: ["reviewer[bot]"] },
		new Set(["reviewer[bot]"]),
	);
	assert.equal(unchanged.previous.lastPollAt, previous.lastPollAt);
});

test("a trust change backfills each unresolved bot comment", () => {
	const baseline = pollBaseline(
		{
			lastPollAt: "2026-01-01T00:00:00Z",
			trustedBots: [],
			threadStates: {},
		},
		new Set(["reviewer[bot]"]),
	);
	assert.equal(baseline.previous.lastPollAt, undefined);
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

test("comment edits produce a new event revision", () => {
	const first = candidateEvents(snapshot(), "2026-01-01T00:01:00Z").find(
		(event) => event.kind === "issue-comment",
	);
	const edited = snapshot();
	edited.issueComments[0].updated_at = "2026-01-01T00:02:00Z";
	const second = candidateEvents(edited, "2026-01-01T00:02:00Z").find(
		(event) => event.kind === "issue-comment",
	);
	assert.notEqual(first.id, second.id);
});

test("a newer comment edit supersedes its pending revision", () => {
	const root = mkdtempSync(join(tmpdir(), "babysit-pr-edit-test-"));
	try {
		execFileSync("git", ["init", "--quiet", root]);
		const paths = statePaths(root, {
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			pr: 42,
		});
		const first = candidateEvents(snapshot(), "2026-01-01T00:01:00Z").find(
			(event) => event.kind === "issue-comment",
		);
		const edited = snapshot();
		edited.issueComments[0].updated_at = "2026-01-01T00:02:00Z";
		const second = candidateEvents(edited, "2026-01-01T00:02:00Z").find(
			(event) => event.kind === "issue-comment",
		);
		queueEvents(paths, [first]);
		queueEvents(paths, [second]);
		assert.deepEqual(
			pendingEvents(paths).map((event) => event.id),
			[second.id],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolved threads acknowledge already queued review comments", () => {
	const root = mkdtempSync(join(tmpdir(), "babysit-pr-resolved-test-"));
	try {
		execFileSync("git", ["init", "--quiet", root]);
		const paths = statePaths(root, {
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			pr: 42,
		});
		const reviewComment = candidateEvents(
			snapshot(),
			"2026-01-01T00:01:00Z",
		).find((event) => event.kind === "review-comment");
		queueEvents(paths, [reviewComment]);
		assert.deepEqual(reconcileResolvedReviewComments(paths, new Set()), [
			reviewComment.id,
		]);
		assert.deepEqual(pendingEvents(paths), []);
		assert.match(
			readFileSync(paths.ackFile(reviewComment.id), "utf8"),
			/"source": "thread-resolved"/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("drops an unnotified check failure when the check recovers during debounce", () => {
	const root = mkdtempSync(join(tmpdir(), "babysit-pr-check-test-"));
	try {
		execFileSync("git", ["init", "--quiet", root]);
		const paths = statePaths(root, {
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			pr: 42,
		});
		const failed = candidateEvents(snapshot(), "2026-01-01T00:01:00Z").filter(
			(event) => event.kind === "check-failed",
		);
		queueEvents(paths, failed);
		assert.equal(pendingEvents(paths).length, 1);
		reconcileUnnotifiedCheckEvents(paths, []);
		assert.equal(pendingEvents(paths).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("keeps a drained check failure pending until acknowledgement", () => {
	const root = mkdtempSync(join(tmpdir(), "babysit-pr-drain-test-"));
	try {
		execFileSync("git", ["init", "--quiet", root]);
		const paths = statePaths(root, {
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			pr: 42,
		});
		const failed = candidateEvents(snapshot(), "2026-01-01T00:01:00Z").filter(
			(event) => event.kind === "check-failed",
		);
		queueEvents(paths, failed);
		assert.equal(drainEvents(paths, 1_000).length, 1);
		reconcileUnnotifiedCheckEvents(paths, []);
		assert.equal(pendingEvents(paths).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects persisted events with an invalid observation timestamp", () => {
	const root = mkdtempSync(join(tmpdir(), "babysit-pr-timestamp-test-"));
	try {
		execFileSync("git", ["init", "--quiet", root]);
		const paths = statePaths(root, {
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			pr: 42,
		});
		const [event] = candidateEvents(snapshot(), "not-a-timestamp");
		queueEvents(paths, [event]);
		assert.throws(() => pendingEvents(paths), /Invalid babysit-pr state/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed owner notification stays inside the watcher error path", () => {
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

test("debounces until quiet, with a hard cap and ten-minute reminders", () => {
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

test("uses the shared git directory and keeps queued events until acknowledgement", () => {
	const root = mkdtempSync(join(tmpdir(), "babysit-pr-test-"));
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
		const identity = {
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			pr: 42,
		};
		const paths = statePaths(worktree, identity);
		assert.equal(paths.root, statePaths(repository, identity).root);
		const [event] = candidateEvents(snapshot(), "2026-01-01T00:01:00Z");
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
