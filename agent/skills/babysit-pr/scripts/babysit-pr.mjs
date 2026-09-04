#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CommandError,
	fetchSnapshot,
	resolvePr,
	runCommand,
} from "./github.mjs";

const POLL_MS = 60_000;
const DEBOUNCE_MS = 30_000;
const MAX_DEBOUNCE_MS = 120_000;
const REMINDER_MS = 600_000;
const FAILURE_NOTICE_MS = 300_000;
const MAX_BACKOFF_MS = 60_000;
const VERSION = 1;
const scriptPath = fileURLToPath(import.meta.url);

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function compactTimestamp(value) {
	return String(value ?? "unknown").replace(/[^0-9A-Za-z]/g, "");
}

export function eventMarker(id) {
	return `<!-- pi-event:${id} -->`;
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
		login !== input.selfLogin &&
		input.trustedLogins.has(login)
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
		if (
			input.initialReconciliation &&
			input.unresolvedReviewCommentIds instanceof Set &&
			!input.unresolvedReviewCommentIds.has(comment.id)
		)
			continue;
		const key = `review-comment:${comment.id}:${compactTimestamp(comment.updated_at)}`;
		events.push(makeEvent(pr, "review-comment", key, observedAt, { comment }));
	}
	for (const review of input.reviews) {
		if (!trustedComment(review, input)) continue;
		const state = String(review.state ?? "").toUpperCase();
		const body = typeof review.body === "string" ? review.body.trim() : "";
		if (!body && state !== "CHANGES_REQUESTED") continue;
		const key = `review:${review.id}:${compactTimestamp(review.submitted_at)}:${state}`;
		events.push(makeEvent(pr, "review", key, observedAt, { review }));
	}
	for (const check of input.checks) {
		if (check.bucket !== "fail" && check.bucket !== "cancel") continue;
		const key = `required-check:${pr.headRefOid}:${check.name}:${compactTimestamp(check.completedAt)}:${check.state}`;
		events.push(makeEvent(pr, "check-failed", key, observedAt, { check }));
	}
	if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
		const key = `merge-conflict:${pr.baseRefOid}:${pr.headRefOid}`;
		events.push(makeEvent(pr, "merge-conflict", key, observedAt, {}));
	}
	if (Number(input.comparison?.behind_by ?? 0) > 0) {
		const key = `behind-target:${pr.baseRefOid}:${pr.headRefOid}`;
		events.push(
			makeEvent(pr, "behind-target", key, observedAt, {
				behindBy: Number(input.comparison.behind_by),
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

function safeComponent(value) {
	return encodeURIComponent(String(value)).replaceAll("%", "_");
}

export function statePaths(cwd, identity) {
	const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
		cwd,
		encoding: "utf8",
	}).trim();
	const common = isAbsolute(raw) ? raw : resolve(cwd, raw);
	const root = join(
		common,
		"pi",
		"babysit-pr",
		safeComponent(identity.host),
		safeComponent(identity.owner),
		safeComponent(identity.repo),
		String(identity.pr),
	);
	return {
		root,
		events: join(root, "events"),
		acks: join(root, "acks"),
		notifications: join(root, "notifications"),
		lock: join(root, "watch.lock"),
		meta: join(root, "meta.json"),
		eventFile: (id) => join(root, "events", `${id}.json`),
		ackFile: (id) => join(root, "acks", `${id}.json`),
		notificationFile: (id) => join(root, "notifications", `${id}.json`),
	};
}

function syncDirectory(path) {
	let fd;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Some filesystems do not permit syncing directories.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function atomicJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	syncDirectory(dirname(path));
}

function validEvent(value) {
	return (
		value &&
		value.version === VERSION &&
		typeof value.id === "string" &&
		/^[a-f0-9]{64}$/.test(value.id) &&
		typeof value.kind === "string" &&
		typeof value.observedAt === "string" &&
		value.marker === eventMarker(value.id)
	);
}

function readJson(path, validator) {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		if (!validator(value)) throw new Error("invalid shape");
		return value;
	} catch (error) {
		const corrupt = `${path}.corrupt-${Date.now()}`;
		try {
			renameSync(path, corrupt);
		} catch {}
		throw new Error(`Invalid babysit-pr state moved to ${corrupt}: ${error}`);
	}
}

export function queueEvents(paths, events) {
	const added = [];
	for (const event of events) {
		if (existsSync(paths.eventFile(event.id))) continue;
		atomicJson(paths.eventFile(event.id), event);
		added.push(event);
	}
	return added;
}

function eventFiles(paths) {
	if (!existsSync(paths.events)) return [];
	return readdirSync(paths.events)
		.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
		.sort();
}

function pendingRecords(paths) {
	const records = [];
	for (const name of eventFiles(paths)) {
		const id = basename(name, ".json");
		if (existsSync(paths.ackFile(id))) continue;
		const event = readJson(paths.eventFile(id), validEvent);
		let emittedAt = null;
		if (existsSync(paths.notificationFile(id))) {
			const notification = readJson(
				paths.notificationFile(id),
				(value) =>
					value?.version === VERSION &&
					value.id === id &&
					typeof value.emittedAt === "number",
			);
			emittedAt = notification.emittedAt;
		}
		records.push({ event, emittedAt });
	}
	return records.sort((left, right) =>
		left.event.observedAt.localeCompare(right.event.observedAt),
	);
}

export function pendingEvents(paths) {
	return pendingRecords(paths).map(({ event }) => event);
}

export function drainEvents(paths, now = Date.now()) {
	const records = pendingRecords(paths);
	markNotified(paths, records, now);
	return records.map(({ event }) => event);
}

export function reconcileUnnotifiedCheckEvents(paths, currentEvents) {
	const current = new Set(
		currentEvents
			.filter((event) => event.kind === "check-failed")
			.map((event) => event.id),
	);
	for (const record of pendingRecords(paths)) {
		if (
			record.event.kind === "check-failed" &&
			record.emittedAt === null &&
			!current.has(record.event.id)
		) {
			rmSync(paths.eventFile(record.event.id), { force: true });
			rmSync(paths.notificationFile(record.event.id), { force: true });
		}
	}
}

export function ackEvents(paths, ids) {
	for (const id of [...new Set(ids)]) {
		if (!/^[a-f0-9]{64}$/.test(id) || !existsSync(paths.eventFile(id)))
			throw new Error(`Unknown babysit-pr event: ${id}`);
		if (!existsSync(paths.ackFile(id)))
			atomicJson(paths.ackFile(id), {
				version: VERSION,
				id,
				acknowledgedAt: new Date().toISOString(),
			});
	}
}

function markNotified(paths, records, emittedAt) {
	for (const { event } of records)
		atomicJson(paths.notificationFile(event.id), {
			version: VERSION,
			id: event.id,
			emittedAt,
		});
}

export function shouldEmit(batch, now) {
	if (batch.lastEmittedAt !== null)
		return now - batch.lastEmittedAt >= REMINDER_MS;
	return (
		now - batch.lastSeenAt >= DEBOUNCE_MS ||
		now - batch.firstSeenAt >= MAX_DEBOUNCE_MS
	);
}

function readMeta(paths) {
	if (!existsSync(paths.meta)) return { threadStates: {} };
	return readJson(
		paths.meta,
		(value) =>
			value?.version === VERSION &&
			value.threadStates &&
			typeof value.threadStates === "object",
	);
}

function reconcileResponseMarkers(paths, comments, selfLogin) {
	const ids = new Set();
	for (const comment of comments) {
		if (comment?.user?.login !== selfLogin || typeof comment.body !== "string")
			continue;
		for (const match of comment.body.matchAll(
			/<!-- pi-event:([a-f0-9]{64}) -->/g,
		))
			ids.add(match[1]);
	}
	for (const id of ids)
		if (existsSync(paths.eventFile(id)) && !existsSync(paths.ackFile(id)))
			atomicJson(paths.ackFile(id), {
				version: VERSION,
				id,
				acknowledgedAt: new Date().toISOString(),
				source: "github-marker",
			});
}

function acquireLock(paths) {
	mkdirSync(paths.root, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(paths.lock);
			atomicJson(join(paths.lock, "owner.json"), {
				version: VERSION,
				pid: process.pid,
				startedAt: new Date().toISOString(),
			});
			return;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			let pid;
			try {
				pid = JSON.parse(
					readFileSync(join(paths.lock, "owner.json"), "utf8"),
				).pid;
				if (Number.isInteger(pid)) process.kill(pid, 0);
				throw new Error(
					`babysit-pr is already watching this PR with PID ${pid}`,
				);
			} catch (lockError) {
				if (lockError.code === "EPERM") throw lockError;
				if (
					lockError instanceof Error &&
					lockError.message.startsWith("babysit-pr is already")
				)
					throw lockError;
				rmSync(paths.lock, { recursive: true, force: true });
			}
		}
	}
	throw new Error("Could not acquire the babysit-pr watcher lock");
}

function emit(message, cwd) {
	runCommand("emit-to-pi", [message], cwd);
}

function notificationMessage(pr, records, paths, reminder) {
	const kinds = [...new Set(records.map(({ event }) => event.kind))].join(", ");
	return `babysit-pr${reminder ? " reminder" : ""}: PR #${pr.number} has ${records.length} pending event${records.length === 1 ? "" : "s"} (${kinds}). Run node ${scriptPath} drain ${pr.url}, follow the babysit-pr skill, then acknowledge each completed event. State: ${paths.root}`;
}

function emitPending(cwd, pr, paths, records, reminder) {
	emit(notificationMessage(pr, records, paths, reminder), cwd);
	markNotified(paths, records, Date.now());
}

function poll(cwd, reference, paths, trustedBots) {
	const previous = readMeta(paths);
	const observedAt = new Date().toISOString();
	const snapshot = fetchSnapshot(cwd, reference, previous, trustedBots);
	reconcileResponseMarkers(
		paths,
		[...snapshot.input.issueComments, ...snapshot.input.reviewComments],
		snapshot.input.selfLogin,
	);
	const candidates = candidateEvents(snapshot.input, observedAt);
	reconcileUnnotifiedCheckEvents(paths, candidates);
	const added = queueEvents(paths, candidates);
	atomicJson(paths.meta, {
		version: VERSION,
		pr: snapshot.pr,
		lastPollAt: observedAt,
		selfLogin: snapshot.input.selfLogin,
		threadStates: Object.fromEntries(snapshot.input.threadStates),
	});
	return { ...snapshot, added };
}

function terminalState(pr) {
	if (pr.mergedAt) return "merged";
	if (pr.state === "CLOSED" || pr.closedAt) return "closed";
	return null;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function settleDebounce(cwd, reference, paths, current, trustedBots) {
	let snapshot = current;
	for (;;) {
		const records = pendingRecords(paths);
		const unnotified = records.filter((record) => record.emittedAt === null);
		if (unnotified.length === 0) return snapshot;
		const firstSeenAt = Math.min(
			...unnotified.map(({ event }) => Date.parse(event.observedAt)),
		);
		const lastSeenAt = Math.max(
			...unnotified.map(({ event }) => Date.parse(event.observedAt)),
		);
		const now = Date.now();
		if (shouldEmit({ firstSeenAt, lastSeenAt, lastEmittedAt: null }, now)) {
			emitPending(cwd, snapshot.pr, paths, records, false);
			return snapshot;
		}
		const dueAt = Math.min(
			lastSeenAt + DEBOUNCE_MS,
			firstSeenAt + MAX_DEBOUNCE_MS,
		);
		await sleep(Math.max(1, dueAt - now));
		snapshot = poll(cwd, reference, paths, trustedBots);
		if (terminalState(snapshot.pr)) return snapshot;
	}
}

function maybeRemind(cwd, pr, paths) {
	const records = pendingRecords(paths);
	if (
		records.length === 0 ||
		records.some((record) => record.emittedAt === null)
	)
		return;
	const lastEmittedAt = Math.min(...records.map((record) => record.emittedAt));
	if (shouldEmit({ firstSeenAt: 0, lastSeenAt: 0, lastEmittedAt }, Date.now()))
		emitPending(cwd, pr, paths, records, true);
}

function failureNeedsImmediateNotice(error) {
	return (
		error instanceof CommandError &&
		(error.status === 4 ||
			/auth|login|permission|forbidden|403/i.test(error.message))
	);
}

async function watch(cwd, reference, trustedBots) {
	const initial = resolvePr(cwd, reference);
	const paths = statePaths(cwd, initial.identity);
	acquireLock(paths);
	const release = () => rmSync(paths.lock, { recursive: true, force: true });
	for (const signal of ["SIGINT", "SIGTERM"])
		process.once(signal, () => {
			release();
			process.exit(0);
		});
	let failureStartedAt = null;
	let failureNotified = false;
	let backoff = 5_000;
	try {
		for (;;) {
			try {
				let snapshot = poll(cwd, reference, paths, trustedBots);
				const ended = terminalState(snapshot.pr);
				if (ended) {
					emit(
						`babysit-pr: PR #${snapshot.pr.number} was ${ended}; monitoring stopped and its local state was removed.`,
						cwd,
					);
					rmSync(paths.root, { recursive: true, force: true });
					return;
				}
				snapshot = await settleDebounce(
					cwd,
					reference,
					paths,
					snapshot,
					trustedBots,
				);
				const endedAfterDebounce = terminalState(snapshot.pr);
				if (endedAfterDebounce) {
					emit(
						`babysit-pr: PR #${snapshot.pr.number} was ${endedAfterDebounce}; monitoring stopped and its local state was removed.`,
						cwd,
					);
					rmSync(paths.root, { recursive: true, force: true });
					return;
				}
				maybeRemind(cwd, snapshot.pr, paths);
				failureStartedAt = null;
				failureNotified = false;
				backoff = 5_000;
				await sleep(POLL_MS);
			} catch (error) {
				const now = Date.now();
				failureStartedAt ??= now;
				if (
					!failureNotified &&
					(failureNeedsImmediateNotice(error) ||
						now - failureStartedAt >= FAILURE_NOTICE_MS)
				) {
					emit(
						`babysit-pr monitoring is impaired for ${reference}: ${error}`,
						cwd,
					);
					failureNotified = true;
				}
				await sleep(backoff);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
			}
		}
	} finally {
		release();
	}
}

function contextFor(cwd, reference) {
	const resolved = resolvePr(cwd, reference);
	return {
		...resolved,
		paths: statePaths(cwd, resolved.identity),
	};
}

function print(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseTrustedBots(args) {
	const bots = new Set();
	for (let index = 0; index < args.length; index += 2) {
		if (args[index] !== "--trusted-bot" || !args[index + 1])
			throw new Error("watch accepts repeated --trusted-bot <login> pairs");
		const login = args[index + 1];
		if (!/^[A-Za-z0-9-]+\[bot\]$/.test(login))
			throw new Error(`Invalid trusted bot login: ${login}`);
		bots.add(login);
	}
	return bots;
}

async function main() {
	const [action, reference, ...ids] = process.argv.slice(2);
	if (!action || !reference)
		throw new Error(
			"usage: babysit-pr <watch|drain|ack|status> <PR number or URL> [event IDs]",
		);
	const cwd = process.cwd();
	switch (action) {
		case "watch":
			await watch(cwd, reference, parseTrustedBots(ids));
			return;
		case "drain": {
			const { paths } = contextFor(cwd, reference);
			print({ state: paths.root, events: drainEvents(paths) });
			return;
		}
		case "ack": {
			if (ids.length === 0)
				throw new Error("ack requires at least one event ID");
			const { paths } = contextFor(cwd, reference);
			ackEvents(paths, ids);
			print({ acknowledged: [...new Set(ids)] });
			return;
		}
		case "status": {
			const { paths, pr } = contextFor(cwd, reference);
			let pid = null;
			if (existsSync(join(paths.lock, "owner.json")))
				try {
					pid = JSON.parse(
						readFileSync(join(paths.lock, "owner.json"), "utf8"),
					).pid;
				} catch {}
			print({
				pr: pr.url,
				state: terminalState(pr) ?? "open",
				watcherPid: pid,
				pending: pendingEvents(paths).length,
				statePath: paths.root,
			});
			return;
		}
		default:
			throw new Error(`Unknown babysit-pr action: ${action}`);
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
