import assert from "node:assert/strict";

const { existsSync, mkdtempSync, readFileSync, unlinkSync } =
	process.getBuiltinModule("fs");
const { tmpdir } = process.getBuiltinModule("os");
const { join } = process.getBuiltinModule("path");

import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Fiber } from "effect";
import { usageView } from "../../process-status/test/usage-fixture.ts";
import type { DelegateSnapshot } from "../contract.ts";
import { DelegateManager } from "../manager.ts";
import {
	DELEGATE_STATE_ENTRY,
	delegateStateRecord,
	recoverDelegateStates,
} from "../persistence.ts";
import type { ChildSession } from "../runtime.ts";
import { createChildSessionManager } from "../runtime.ts";
import { deferredPromise, eventually } from "./eventually.ts";
import { context, FakeChild } from "./manager-fixture.ts";

function sessionFile(manager: SessionManager): string {
	const file = manager.getSessionFile();
	assert.ok(file);
	return file;
}

function snapshot(id = "delegate-1"): DelegateSnapshot {
	return {
		id,
		status: "done",
		createdAt: 1,
		settledAt: 2,
		output: "finished",
		success: true,
		assignedTask: "inspect persistence",
		effort: "fast",
		requestedModel: "test/model",
		thinking: "low",
		durationMs: 1,
		toolCalls: 0,
		failedToolCalls: 0,
		childUsage: {
			turns: 1,
			input: 2,
			output: 3,
			cacheRead: 4,
			cacheWrite: 5,
			totalTokens: 14,
			cost: 0.25,
		},
		aborted: false,
	};
}

test("native parent entries recover only explicitly owned delegates", () => {
	const root = mkdtempSync(join(tmpdir(), "delegate-persistence-"));
	const parent = SessionManager.create(root, join(root, "sessions"));
	parent.appendMessage({
		role: "assistant",
		content: [],
		stopReason: "stop",
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	});
	parent.appendCustomEntry(
		DELEGATE_STATE_ENTRY,
		delegateStateRecord(parent.getSessionId(), "settled", snapshot()),
	);
	const file = parent.getSessionFile();
	assert.ok(file);

	const reopened = SessionManager.open(file);
	assert.deepEqual(recoverDelegateStates(reopened), [snapshot()]);

	const fork = SessionManager.forkFrom(file, root, join(root, "forks"));
	assert.deepEqual(recoverDelegateStates(fork), []);
});

test("reopened delegates remain available for inspection only", () => {
	const manager = new DelegateManager({ recovered: [snapshot()] });
	assert.deepEqual(manager.list(["delegate-1"]), [snapshot()]);
	assert.deepEqual(manager.trail("delegate-1"), ["Assistant\n\nfinished"]);
	return assert.rejects(
		() => Effect.runPromise(manager.send("delegate-1", "continue")),
		/inspection only/,
	);
});

test("native child uses parent-scoped custom directory and parent link", () => {
	const root = mkdtempSync(join(tmpdir(), "delegate-child-session-"));
	const parentDir = join(root, "custom-sessions");
	const parent = SessionManager.create(root, parentDir);
	parent.appendCustomEntry("force-parent-file", {});
	const child = createChildSessionManager(root, parent);
	child.appendMessage({
		role: "assistant",
		content: [],
		stopReason: "stop",
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	});
	const childFile = child.getSessionFile();
	assert.ok(childFile);
	assert.equal(
		childFile.startsWith(join(parentDir, "delegates", parent.getSessionId())),
		true,
	);
	assert.equal(
		JSON.parse(readFileSync(childFile, "utf8").split("\n")[0]).parentSession,
		parent.getSessionFile(),
	);

	const memoryChild = createChildSessionManager(
		root,
		SessionManager.inMemory(root),
	);
	memoryChild.appendMessage({
		role: "assistant",
		content: [],
		stopReason: "stop",
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	});
	assert.equal(memoryChild.getSessionFile(), undefined);
	assert.equal(
		existsSync(join(parentDir, "delegates", parent.getSessionId())),
		true,
	);
});

test("blocking completion persists settlement independently of background delivery", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const child = new FakeChild();
			const records: DelegateSnapshot[] = [];
			const delivered: DelegateSnapshot[] = [];
			const manager = new DelegateManager({
				createSession: () => Promise.resolve(child as unknown as ChildSession),
				shutdownSession: () => {
					child.disposeNow();
					return Promise.resolve();
				},
				onSettlement: (value) => records.push(value),
				onSettled: (value) => delivered.push(value),
			});
			const run = manager.spawn({
				task: "durable blocking completion",
				ctx: context,
			});
			const waiting = yield* Effect.forkChild(manager.wait([run.id]));
			yield* eventually(() => child.isStreaming);
			child.finish("saved result");
			yield* Fiber.join(waiting);
			assert.equal(records.length, 1);
			assert.equal(records[0].status, "done");
			assert.equal(records[0].output, "saved result");
			assert.equal(delivered.length, 0);
			yield* manager.shutdown();
		}),
	));

function assistant(text = "native completed response") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		stopReason: "stop" as const,
		api: "test",
		provider: "test",
		model: "test",
		timestamp: 1,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 17,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		},
	};
}

test("crash recovery reads completed native responses without inferring successful settlement", () => {
	const root = mkdtempSync(join(tmpdir(), "delegate-crash-"));
	const parent = SessionManager.create(root, join(root, "configured"));
	parent.appendMessage(assistant("delegate tool call"));
	const child = createChildSessionManager(root, parent);
	parent.appendCustomEntry(
		DELEGATE_STATE_ENTRY,
		delegateStateRecord(parent.getSessionId(), "started", {
			...snapshot(),
			status: "running",
			childSessionId: child.getSessionId(),
			childSessionFile: child.getSessionFile(),
		}),
	);
	child.appendMessage(assistant());
	const before = readFileSync(sessionFile(child), "utf8");
	for (let i = 0; i < 2; i++) {
		const reopened = SessionManager.open(sessionFile(parent));
		const manager = new DelegateManager({
			recovered: recoverDelegateStates(reopened),
		});
		assert.equal(manager.list()[0].status, "error");
		assert.equal(manager.list()[0].output, "native completed response");
		assert.equal(manager.sessionUsage().cost, 0.5);
		assert.equal(manager.sessionUsage().totalTokens, 17);
		assert.equal(readFileSync(sessionFile(child), "utf8"), before);
	}
});

test("malformed owned snapshots cannot crash accounting or silently erase unknown cost", () => {
	const parent = SessionManager.inMemory(process.cwd());
	parent.appendCustomEntry(DELEGATE_STATE_ENTRY, {
		kind: "settled",
		ownerSessionId: parent.getSessionId(),
		snapshot: { ...snapshot(), childUsage: null },
	});
	const manager = new DelegateManager({
		recovered: recoverDelegateStates(parent),
	});
	assert.equal(manager.list()[0].status, "error");
	assert.equal(manager.sessionUsage().cost, null);
	assert.equal(manager.sessionUsage().totalTokens, null);
});

test("native assistant, tool and compaction usage stays identical across live settlement and reopen", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), "delegate-accounting-"));
			const parent = SessionManager.create(root, join(root, "sessions"));
			parent.appendMessage(assistant("parent tool call"));
			const child = new FakeChild(createChildSessionManager(root, parent));
			const persist = (
				kind: "accepted" | "started" | "settled",
				value: DelegateSnapshot,
			) =>
				parent.appendCustomEntry(
					DELEGATE_STATE_ENTRY,
					delegateStateRecord(parent.getSessionId(), kind, value),
				);
			const manager = new DelegateManager({
				createSession: () => Promise.resolve(child as unknown as ChildSession),
				shutdownSession: () => {
					child.disposeNow();
					return Promise.resolve();
				},
				onAccepted: (value) => persist("accepted", value),
				onStarted: (value) => persist("started", value),
				onSettlement: (value) => persist("settled", value),
			});
			const run = manager.spawn({ task: "native accounting", ctx: context });
			yield* eventually(() => child.isStreaming);
			child.emit({ type: "message_end", message: assistant() });
			child.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [],
				isError: false,
				timestamp: 2,
				usage: assistant().usage,
			});
			const leafId = child.sessionManager.getLeafId();
			assert.ok(leafId);
			child.sessionManager.appendCompaction(
				"summary",
				leafId,
				17,
				undefined,
				false,
				assistant().usage,
			);
			assert.equal(manager.sessionUsage().cost, 1.5);
			assert.equal(manager.sessionUsage().totalTokens, 51);
			child.finishWithoutResponse();
			yield* manager.wait([run.id]);
			yield* manager.shutdown();
			const reopened = new DelegateManager({
				recovered: recoverDelegateStates(
					SessionManager.open(sessionFile(parent)),
				),
			});
			assert.equal(reopened.sessionUsage().cost, 1.5);
			assert.equal(reopened.sessionUsage().totalTokens, 51);
			assert.equal(reopened.list()[0].status, "done");
		}),
	));

for (const ending of ["cancel", "shutdown", "failure"] as const) {
	test(`${ending} persists one terminal record and the latest completed native response`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const root = mkdtempSync(join(tmpdir(), "delegate-lifecycle-"));
				const parent = SessionManager.create(root, join(root, "configured"));
				parent.appendMessage(assistant("parent tool call"));
				const child = new FakeChild(createChildSessionManager(root, parent));
				const persist = (
					kind: "accepted" | "started" | "settled",
					value: DelegateSnapshot,
				) =>
					parent.appendCustomEntry(
						DELEGATE_STATE_ENTRY,
						delegateStateRecord(parent.getSessionId(), kind, value),
					);
				const manager = new DelegateManager({
					createSession: () =>
						Promise.resolve(child as unknown as ChildSession),
					shutdownSession: () => {
						child.disposeNow();
						return Promise.resolve();
					},
					onAccepted: (value) => persist("accepted", value),
					onStarted: (value) => persist("started", value),
					onSettlement: (value) => persist("settled", value),
				});
				const run = manager.spawn({ task: ending, ctx: context });
				yield* eventually(() => child.isStreaming);
				const beforeResponse = recoverDelegateStates(
					SessionManager.open(sessionFile(parent)),
				);
				assert.equal(
					beforeResponse[0].childSessionId,
					child.sessionManager.getSessionId(),
				);
				assert.equal(
					beforeResponse[0].childSessionFile,
					child.sessionManager.getSessionFile(),
				);
				assert.equal(existsSync(sessionFile(child.sessionManager)), false);
				assert.equal(
					new DelegateManager({ recovered: beforeResponse }).sessionUsage()
						.cost,
					null,
				);
				child.emit({
					type: "message_end",
					message: assistant("last completed response"),
				});
				if (ending === "failure") {
					child.rejectPrompt(new Error("transport failed"));
					yield* manager.wait([run.id]);
				} else if (ending === "cancel") yield* manager.cancel([run.id]);
				yield* manager.shutdown();
				const entries = parent
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "custom" &&
							entry.customType === DELEGATE_STATE_ENTRY,
					);
				assert.equal(entries.length, 3);
				const reopened = new DelegateManager({
					recovered: recoverDelegateStates(
						SessionManager.open(sessionFile(parent)),
					),
				});
				assert.equal(
					reopened.list()[0].status,
					ending === "failure" ? "error" : "cancelled",
				);
				assert.equal(reopened.list()[0].output, "last completed response");
				const view = usageView(SessionManager.open(sessionFile(parent)), () =>
					reopened.sessionUsage(),
				);
				const result = yield* Effect.promise(view.query);
				assert.deepEqual(result.details, {
					parent: {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 2,
						cacheWriteTokens: 0,
						totalTokens: 17,
						usd: 0.5,
					},
					delegates: {
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 2,
						cacheWriteTokens: 0,
						totalTokens: 17,
						usd: 0.5,
					},
					total: {
						inputTokens: 20,
						outputTokens: 10,
						cacheReadTokens: 4,
						cacheWriteTokens: 0,
						totalTokens: 34,
						usd: 1,
					},
				});
				assert.match(view.render(), /USD 1\.000/);
				assert.match(view.render(), /10\.0%\/1\.0k/);
				assert.match(view.render(), /test-model/);
				view.dispose();
			}),
		));
}

test("failure before child creation remains owned and unavailable after reopen", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), "delegate-early-failure-"));
			const parent = SessionManager.create(root, join(root, "sessions"));
			parent.appendMessage(assistant("parent tool call"));
			const manager = new DelegateManager({
				createSession: () => Promise.reject(new Error("creation failed")),
				onAccepted: (value) =>
					parent.appendCustomEntry(
						DELEGATE_STATE_ENTRY,
						delegateStateRecord(parent.getSessionId(), "accepted", value),
					),
				onSettlement: (value) =>
					parent.appendCustomEntry(
						DELEGATE_STATE_ENTRY,
						delegateStateRecord(parent.getSessionId(), "settled", value),
					),
			});
			const run = manager.spawn({ task: "creation fails", ctx: context });
			yield* manager.wait([run.id]);
			const reopened = new DelegateManager({
				recovered: recoverDelegateStates(
					SessionManager.open(sessionFile(parent)),
				),
			});
			assert.equal(reopened.list()[0].error, "creation failed");
			assert.equal(reopened.sessionUsage().cost, null);
			yield* manager.shutdown();
		}),
	));

test("settled native history overrides stale snapshot usage and missing files remain unavailable without recreation", () => {
	const root = mkdtempSync(join(tmpdir(), "delegate-authority-"));
	const parent = SessionManager.create(root, join(root, "sessions"));
	parent.appendMessage(assistant("parent tool call"));
	const child = createChildSessionManager(root, parent);
	child.appendMessage(assistant());
	parent.appendCustomEntry(
		DELEGATE_STATE_ENTRY,
		delegateStateRecord(parent.getSessionId(), "settled", {
			...snapshot(),
			childSessionId: child.getSessionId(),
			childSessionFile: child.getSessionFile(),
		}),
	);
	for (let i = 0; i < 2; i++) {
		const manager = new DelegateManager({
			recovered: recoverDelegateStates(
				SessionManager.open(sessionFile(parent)),
			),
		});
		assert.equal(manager.list()[0].status, "done");
		assert.equal(manager.sessionUsage().cost, 0.5);
		assert.equal(manager.sessionUsage().totalTokens, 17);
		assert.match(
			manager.trail("delegate-1").join("\n"),
			/native completed response/,
		);
	}
	unlinkSync(sessionFile(child));
	const missing = new DelegateManager({
		recovered: recoverDelegateStates(SessionManager.open(sessionFile(parent))),
	});
	assert.equal(missing.list()[0].status, "done");
	assert.equal(missing.sessionUsage().cost, null);
	assert.equal(missing.sessionUsage().totalTokens, null);
	assert.equal(existsSync(sessionFile(child)), false);
});

test("a child created after cancellation cannot overwrite durable terminal status", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const root = mkdtempSync(join(tmpdir(), "delegate-late-child-"));
			const parent = SessionManager.create(root, join(root, "sessions"));
			parent.appendMessage(assistant("parent tool call"));
			const created = Deferred.makeUnsafe<ChildSession>();
			let creating = false;
			const persist = (
				kind: "accepted" | "started" | "settled",
				value: DelegateSnapshot,
			) =>
				parent.appendCustomEntry(
					DELEGATE_STATE_ENTRY,
					delegateStateRecord(parent.getSessionId(), kind, value),
				);
			const child = new FakeChild(createChildSessionManager(root, parent));
			const manager = new DelegateManager({
				createSession: () => {
					creating = true;
					return deferredPromise(created);
				},
				shutdownSession: () => {
					child.disposeNow();
					return Promise.resolve();
				},
				onAccepted: (value) => persist("accepted", value),
				onStarted: (value) => persist("started", value),
				onSettlement: (value) => persist("settled", value),
			});
			const run = manager.spawn({
				task: "cancel during creation",
				ctx: context,
			});
			yield* eventually(() => creating);
			yield* manager.cancel([run.id]);
			yield* Deferred.succeed(created, child as unknown as ChildSession);
			yield* eventually(() => child.disposed);
			const reopened = new DelegateManager({
				recovered: recoverDelegateStates(
					SessionManager.open(sessionFile(parent)),
				),
			});
			assert.equal(reopened.list()[0].status, "cancelled");
			assert.equal(reopened.sessionUsage().cost, null);
			yield* manager.shutdown();
		}),
	));
