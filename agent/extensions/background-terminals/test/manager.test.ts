// biome-ignore-all format: Effect test boundaries stay compact to keep the conversion deletion-first.
import assert from "node:assert/strict";
import { Clock, Effect } from "effect";

const { mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");

import { tmpdir } from "node:os";

const { join } = process.getBuiltinModule("node:path");

import test from "node:test";
import { processIsGone } from "../../test/process.ts";
import {
	BackgroundTerminalManager,
	MAX_TRACKED,
	RETAINED_BYTES,
	type SettledTerminalSnapshot,
	terminalResultFields,
} from "../manager.ts";
import { nodeCommand } from "./node-command.ts";

const cwd = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
test.after(() => rmSync(cwd, { recursive: true, force: true }));
const wait = (ms: number) => Effect.sleep(ms);
const now = () => Effect.runSync(Clock.currentTimeMillis);
const killProcess = (pid: number) => Effect.sync(() => {
	if (pid && !processIsGone(pid))
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
});
const settled = Effect.fn("settled")(function* (manager: BackgroundTerminalManager, id: string, timeout = 6_000): Effect.fn.Return<SettledTerminalSnapshot> {
	const deadline = now() + timeout;
	while (now() < deadline) {
		const snapshot = manager.get(id);
		if (snapshot && snapshot.state !== "running") return snapshot;
		yield* wait(20);
	}
	throw new Error(`timeout waiting for ${id}`);
});

test("captures stdout and stderr and classifies success and nonzero", () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const ok = manager.start({
		command: "printf out; printf err >&2",
		title: "ok",
		cwd,
	});
	const bad = manager.start({
		command: "printf nope >&2; exit 7",
		title: "bad",
		cwd,
	});
	assert.equal((yield* settled(manager, ok.id)).state, "done");
	const failed = yield* settled(manager, bad.id);
	assert.equal(failed.state, "failed");
	assert.equal(terminalResultFields(failed).exitCode, 7);
	const completed = manager.get(ok.id);
	assert.ok(completed);
	assert.equal(completed.stdout.text, "out");
	assert.equal(completed.stderr.text, "err");
	yield* manager.shutdown();
})));

test("retains a UTF-8-safe newest 256 KiB tail with byte counts", () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const bytes = RETAINED_BYTES + 4099;
	const run = manager.start({
		command: `node -e 'process.stdout.write("é".repeat(${Math.ceil(bytes / 2)}))'`,
		title: "large",
		cwd,
	});
	const snapshot = yield* settled(manager, run.id);
	assert.ok(Buffer.byteLength(snapshot.stdout.text) <= RETAINED_BYTES);
	assert.ok(!snapshot.stdout.text.startsWith("�"));
	assert.equal(
		snapshot.stdout.totalBytes - Buffer.byteLength(snapshot.stdout.text),
		snapshot.stdout.truncatedBytes,
	);
	assert.ok(snapshot.stdout.truncatedBytes > 0);
	yield* manager.shutdown();
})));

test("retains exact newest output after many small writes", () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const writes = RETAINED_BYTES + 10_000;
	const run = manager.start({
		command: `node -e 'for(let i=0;i<${writes};i++)process.stdout.write(String(i%10))'`,
		title: "chatty",
		cwd,
	});
	const snapshot = yield* settled(manager, run.id);
	assert.equal(snapshot.stdout.totalBytes, writes);
	assert.equal(Buffer.byteLength(snapshot.stdout.text), RETAINED_BYTES);
	assert.equal(snapshot.stdout.truncatedBytes, writes - RETAINED_BYTES);
	assert.equal(snapshot.stdout.text.slice(-20), "45678901234567890123");
	yield* manager.shutdown();
})));

test("prunes to the tracked bound without evicting running entries", () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const running = Array.from({ length: 2 }, (_, index) =>
		manager.start({ command: "sleep 30", title: String(index), cwd }),
	);
	for (let index = 0; index < MAX_TRACKED + 3; index++) {
		const run = manager.start({
			command: "true",
			title: `quick-${index}`,
			cwd,
		});
		yield* settled(manager, run.id);
	}
	assert.equal(manager.list().length, MAX_TRACKED);
	const tracked = new Set(manager.list().map((entry) => entry.id));
	assert.ok(running.every((run) => tracked.has(run.id)));
	yield* manager.shutdown();
})));

test("kill returns every result when active terminals exceed retention", () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const runs = Array.from({ length: MAX_TRACKED + 1 }, (_, index) =>
		manager.start({ command: "sleep 30", title: `active-${index}`, cwd }),
	);
	try {
		const results = yield* manager.kill(runs.map((run) => run.id));
		assert.deepEqual(
			results.map((result) => result.id),
			runs.map((run) => run.id),
		);
		assert.ok(results.every((result) => result.state === "killed"));
	} finally {
		yield* manager.shutdown();
	}
})));

test("repeated and overlapping kills settle once", () => Effect.runPromise(Effect.gen(function* () {
	let notifications = 0;
	const manager = new BackgroundTerminalManager(() => notifications++);
	const run = manager.start({ command: "sleep 30", title: "repeat", cwd });
	const [first, second] = yield* Effect.all(
		[manager.kill([run.id]), manager.kill([run.id, run.id])],
		{ concurrency: "unbounded" },
	);
	assert.equal(first[0].state, "killed");
	assert.equal(second[0].state, "killed");
	assert.equal(notifications, 1);
	yield* manager.shutdown();
})));

test("a user kill takes ownership of stalled-pipe termination already in flight", {
	skip: process.platform === "win32",
}, () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const run = manager.start({
		command:
			`sh -c 'trap "echo automatic-termination-started" TERM; while true; do sleep 30; done' & exit 0`,
		title: "stalled pipes",
		cwd,
	});
	try {
		const deadline = now() + 4_000;
		while (
			now() < deadline &&
			!manager
				.get(run.id)
				?.stdout.text.includes("automatic-termination-started")
		)
			yield* wait(20);
		assert.match(
			manager.get(run.id)?.stdout.text ?? "",
			/automatic-termination-started/,
		);
		const [result] = yield* manager.kill([run.id]);
		assert.equal(result.state, "killed");
		assert.equal(result.killed, true);
		assert.equal(manager.get(run.id)?.state, "killed");
	} finally {
		yield* manager.shutdown();
	}
})));

test("escalates SIGTERM and cleans the POSIX process group", {
	skip: process.platform === "win32",
}, () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const run = manager.start({
		command: "trap '' TERM; sleep 30 & echo child:$!; wait",
		title: "stubborn",
		cwd,
	});
	yield* wait(100);
	const running = manager.get(run.id);
	assert.ok(running);
	const childPid = Number(/child:(\d+)/.exec(running.stdout.text)?.[1]);
	assert.ok(childPid);
	const started = now();
	yield* manager.kill([run.id]);
	const snapshot = manager.get(run.id);
	assert.equal(snapshot?.state, "killed");
	assert.ok(now() - started >= 1_800);
	assert.ok(now() - started < 5_000);
	for (let attempt = 0; attempt < 50 && !processIsGone(childPid); attempt++)
		yield* wait(20);
	assert.ok(processIsGone(childPid));
	yield* manager.shutdown();
})));

test("shutdown kills a process group after its shell exits", {
	skip: process.platform === "win32",
}, () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const run = manager.start({
		command: "sleep 30 >/dev/null 2>&1 & echo child:$!",
		title: "detached descendant",
		cwd,
	});
	let childPid = 0;
	try {
		const deadline = now() + 2_000;
		while (now() < deadline) {
			const snapshot = manager.get(run.id);
			assert.ok(snapshot);
			childPid = Number(/child:(\d+)/.exec(snapshot.stdout.text)?.[1]);
			if (childPid && run.pid && processIsGone(run.pid)) break;
			yield* wait(20);
		}
		assert.ok(childPid);
		assert.ok(run.pid && processIsGone(run.pid));
		assert.ok(!processIsGone(childPid));
		yield* manager.shutdown();
		for (let attempt = 0; attempt < 50 && !processIsGone(childPid); attempt++)
			yield* wait(20);
		assert.ok(processIsGone(childPid));
	} finally {
		yield* killProcess(childPid);
	}
})));

test("shutdown kills running processes without delivering completion", () => Effect.runPromise(Effect.gen(function* () {
	let notifications = 0;
	const manager = new BackgroundTerminalManager(() => notifications++);
	const run = manager.start({ command: "sleep 30", title: "shutdown", cwd });
	assert.ok(run.pid);
	yield* manager.shutdown();
	assert.equal(manager.list().length, 0);
	assert.equal(notifications, 0);
	assert.ok(processIsGone(run.pid));
})));

test("releases inherited pipe handles after bounded termination", {
	skip: process.platform === "win32",
}, () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const run = manager.start({
		command:
			'node -e \'const {spawn}=require("node:child_process");const child=spawn("sleep",["30"],{detached:true,stdio:["ignore",1,2]});console.log("escaped:"+child.pid);child.unref()\'',
		title: "escaped pipes",
		cwd,
	});
	let escapedPid = 0;
	try {
		const snapshot = yield* settled(manager, run.id, 6_000);
		escapedPid = Number(/escaped:(\d+)/.exec(snapshot.stdout.text)?.[1]);
		assert.ok(escapedPid);
		assert.equal(processIsGone(escapedPid), false);
		assert.match(terminalResultFields(snapshot).error ?? "", /stdio did not close/);
		assert.ok(snapshot.settledAt - snapshot.createdAt < 5_000);
	} finally {
		yield* manager.shutdown();
		yield* killProcess(escapedPid);
	}
})));

test("bounds settlement when descendants retain inherited pipes", {
	skip: process.platform === "win32",
}, () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	const run = manager.start({
		command: "(sleep 30) & exit 0",
		title: "pipes",
		cwd,
	});
	const snapshot = yield* settled(manager, run.id, 5_000);
	assert.equal(snapshot.state, "done");
	assert.ok(snapshot.settledAt - snapshot.createdAt < 4_500);
	yield* manager.shutdown();
})));

const fromPromise = <A>(value: A | PromiseLike<A>) =>
	Effect.promise(() => Promise.resolve(value));

test("wait returns complete output and repeats settled results without suppressing delivery", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const notifications: boolean[] = [];
			const manager = new BackgroundTerminalManager((_snapshot, consumed) =>
				notifications.push(consumed),
			);
			try {
				const started = manager.start({
					command: "sleep 0.1; printf waited",
					title: "wait",
					cwd,
				});
				const [one, two] = yield* fromPromise(
					Promise.all([
						Effect.runPromise(manager.wait(started.id)),
						Effect.runPromise(manager.wait(started.id)),
					]),
				);
				assert.equal(one.stdout.text, "waited");
				assert.deepEqual(two, one);
				assert.deepEqual(yield* manager.wait(started.id), one);
				assert.deepEqual(notifications, [false]);
				yield* fromPromise(
					assert.rejects(
						Effect.runPromise(manager.wait("foreign")),
						/Unknown terminal id/,
					),
				);
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

test("aborting wait leaves the process alive and restores automatic completion", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const notifications: boolean[] = [];
			const manager = new BackgroundTerminalManager((_snapshot, consumed) =>
				notifications.push(consumed),
			);
			try {
				const started = manager.start({
					command: "sleep 0.2; printf survived",
					title: "abort",
					cwd,
				});
				const controller = new AbortController();
				const pending = Effect.runPromise(manager.wait(started.id), {
					signal: controller.signal,
				});
				controller.abort();
				yield* fromPromise(assert.rejects(pending));
				assert.equal(manager.get(started.id)?.state, "running");
				assert.equal(processIsGone(started.pid ?? 0), false);
				const result = yield* settled(manager, started.id);
				assert.equal(result.stdout.text, "survived");
				assert.deepEqual(notifications, [false]);
			} finally {
				yield* manager.shutdown();
			}
		}),
	));

test("shutdown settles outstanding waiters and clears tracked results", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const manager = new BackgroundTerminalManager();
			const started = manager.start({
				command: "sleep 30",
				title: "shutdown",
				cwd,
			});
			const pending = Effect.runPromise(manager.wait(started.id));
			yield* manager.shutdown();
			assert.equal((yield* fromPromise(pending)).state, "killed");
			assert.deepEqual(manager.list(), []);
		}),
	));

test("list returns output-free metadata while detail and wait retain output", () => Effect.runPromise(Effect.gen(function* () {
	const manager = new BackgroundTerminalManager();
	try {
		const run = manager.start({ command: nodeCommand('process.stdout.write("é"); process.stderr.write("err"); setTimeout(() => {}, 30000)'), title: "metadata", cwd });
		const deadline = now() + 5000;
		while (manager.get(run.id)?.stderr.text !== "err" && now() < deadline)
			yield* Effect.sleep(20);
		const detail = manager.get(run.id);
		assert.ok(detail);
		assert.equal(detail.stdout.text, "é");
		const { stdout, stderr, ...metadata } = detail;
		assert.deepEqual(manager.list(), [{ ...metadata, stdout: { totalBytes: 2, truncatedBytes: 0 }, stderr: { totalBytes: 3, truncatedBytes: 0 } }]);
		yield* manager.kill([run.id]);
		const result = yield* manager.wait(run.id);
		assert.equal(result.stdout.text, "é");
		assert.equal(result.stderr.text, "err");
		assert.equal("text" in manager.list()[0].stdout, false);
	} finally {
		yield* manager.shutdown();
	}
})));
