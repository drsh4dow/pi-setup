import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ackEvents,
	candidateEvents,
	eventMarker,
	pendingEvents,
	queueEvents,
	reconcileUnnotifiedCheckEvents,
	shouldEmit,
	statePaths,
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
		initialReconciliation: true,
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

test("later polls retain trusted comments even if their thread was resolved quickly", () => {
	const later = snapshot();
	later.initialReconciliation = false;
	assert.equal(
		candidateEvents(later, "2026-01-01T00:01:00Z").filter(
			(event) => event.kind === "review-comment",
		).length,
		2,
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
