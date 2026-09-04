import assert from "node:assert/strict";

const { mkdtemp, rm } = process.getBuiltinModule("fs/promises");

import { tmpdir } from "node:os";

const { join } = process.getBuiltinModule("path");

import test from "node:test";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Schema } from "effect";
import backgroundExtension from "../../background-terminals/index.ts";
import compactionExtension from "../../compaction/index.ts";
import { processIsGone } from "../../test/process.ts";
import { DelegateManager } from "../manager.ts";
import { shutdownChild } from "../runtime.ts";
import { context } from "./manager-fixture.ts";

function gate() {
	const deferred = Deferred.makeUnsafe<void>();
	return {
		promise: Effect.runPromise(Deferred.await(deferred)),
		resolve: () => Effect.runSync(Deferred.succeed(deferred, undefined)),
	};
}

type Scenario =
	| "ordinary"
	| "queued-user"
	| "continue"
	| "done"
	| "ask-user"
	| "cancel"
	| "compaction-error"
	| "handoff-aborted";

const runScenario = Effect.fn("runScenario")(function* (scenario: Scenario) {
	const services = yield* Effect.context<never>();
	const cwd = yield* Effect.promise(() =>
		mkdtemp(join(tmpdir(), "pi-settlement-")),
	);
	const compacting = gate();
	const compacted = gate();
	const continuation = gate();
	const releaseContinuation = gate();
	let compactionAborted = false;
	const releaseCompaction = gate();
	const delivered: string[] = [];
	const settled = gate();
	let calls = -1;
	let terminalPid: number | undefined;
	let abortCalls = 0;
	const restoredToEditor: string[] = [];
	const seenUserMessages = new Set<string>();
	const assertTerminalAlive = () => {
		assert.ok(terminalPid);
		assert.equal(processIsGone(terminalPid), false);
	};
	const runtime = yield* Effect.promise(() =>
		ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			modelsStorePath: join(cwd, "models-store.json"),
			refreshOnCreate: false,
		}),
	);
	runtime.registerProvider("settlement-fixture", {
		baseUrl: "http://unused.invalid",
		apiKey: "fixture",
		api: "openai-completions",
		models: [
			{
				id: "model",
				name: "fixture",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
		streamSimple: (model, modelContext) => {
			for (const message of modelContext.messages) {
				if (message.role !== "user") continue;
				const text =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n");
				seenUserMessages.add(text);
			}
			calls++;
			if (calls === 2 && scenario === "queued-user") {
				void session.steer("Include the revised figures");
				void session.followUp("Also write the appendix");
			}
			const text =
				calls === 1
					? "Working on the report"
					: calls === 2
						? `## Handoff\n- Objective: write report\n- Continuation: ${scenario === "cancel" ? "continue" : scenario === "queued-user" ? "done" : scenario}`
						: "Report complete";
			const message: AssistantMessage = {
				role: "assistant",
				content:
					calls === 0
						? [
								{
									type: "toolCall",
									id: "start-server",
									name: "bg_start",
									arguments: {
										command: "sleep 60",
										title: "compaction server",
									},
								},
							]
						: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason:
					calls === 0
						? "toolUse"
						: calls === 2 && scenario === "handoff-aborted"
							? "aborted"
							: "stop",
				timestamp: 1,
				usage: {
					input: scenario !== "ordinary" && calls > 0 && calls < 3 ? 8600 : 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens:
						scenario !== "ordinary" && calls > 0 && calls < 3 ? 8620 : 120,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
			};
			const stream = createAssistantMessageEventStream();
			if (calls === 3 && scenario === "continue") {
				continuation.resolve();
				void releaseContinuation.promise.then(() =>
					stream.push({ type: "done", reason: "stop", message }),
				);
			} else if (message.stopReason === "aborted")
				stream.push({ type: "error", reason: "aborted", error: message });
			else
				stream.push({
					type: "done",
					reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
					message,
				});
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({
		compaction: {
			enabled: true,
			reserveTokens: 100,
			keepRecentTokens: 100,
		},
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		extensionFactories: [
			backgroundExtension,
			(pi) => {
				pi.on("tool_result", (event) => {
					if (event.toolName === "bg_start") {
						terminalPid = Schema.decodeUnknownSync(
							Schema.Struct({ pid: Schema.Number }),
						)(event.details).pid;
					}
				});
			},
			(pi) => {
				pi.on("session_before_compact", (event) => {
					if (event.reason === "manual") {
						compacting.resolve();
						event.signal.addEventListener(
							"abort",
							() => {
								compactionAborted = true;
								releaseCompaction.resolve();
							},
							{ once: true },
						);
						return releaseCompaction.promise.then(() =>
							scenario === "compaction-error" ? { cancel: true } : undefined,
						);
					}
				});
			},
			(pi) => {
				pi.events.on("compaction:delivery-pause", (paused) => {
					if (paused === false) compacted.resolve();
				});
				compactionExtension(pi, () => true);
			},
		],
	});
	yield* Effect.promise(() => loader.reload());
	const { session } = yield* Effect.promise(() =>
		createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime: runtime,
			model: runtime.getModel("settlement-fixture", "model"),
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "builtin",
		}),
	);
	yield* Effect.promise(() =>
		session.bindExtensions({
			mode: scenario === "queued-user" ? "tui" : "print",
			abortHandler:
				scenario === "queued-user"
					? () => {
							// InteractiveMode.restoreQueuedMessagesToEditor clears both queues
							// before aborting the low-level agent. No terminal UI is needed here.
							abortCalls++;
							const { steering, followUp } = session.clearQueue();
							restoredToEditor.push(...steering, ...followUp);
							session.agent.abort();
						}
					: undefined,
			onError: ({ error }) => {
				throw new Error(error);
			},
		}),
	);
	let disposed = false;
	const manager = new DelegateManager({
		createSession: () => Promise.resolve(session),
		shutdownSession: () => {
			disposed = true;
			return Effect.runPromiseWith(services)(
				Effect.gen(function* () {
					assertTerminalAlive();
					yield* shutdownChild(session);
					assert.ok(terminalPid);
					assert.ok(processIsGone(terminalPid));
				}),
			);
		},
		onSettled: (snapshot) => {
			delivered.push(snapshot.status);
			settled.resolve();
		},
	});
	try {
		const job = manager.spawn({
			task: "Write the report",
			background: true,
			cwd,
			ctx: context,
		});
		if (scenario === "ordinary") {
			yield* Effect.promise(() => settled.promise);
			const [result] = yield* manager.wait([job.id]);
			assert.equal(result?.status, "done");
			assert.equal(calls, 1);
			return;
		}
		if (scenario === "handoff-aborted") {
			const first = yield* Effect.raceFirst(
				Effect.promise(() => compacting.promise).pipe(Effect.as("compacting")),
				Effect.promise(() => settled.promise).pipe(Effect.as("settled")),
			);
			assert.equal(first, "settled");
			assert.equal(manager.list([job.id])[0]?.status, "cancelled");
			assert.equal(calls, 2);
			return;
		}
		yield* Effect.promise(() => compacting.promise);
		// Drain runnable work while the actual SDK compaction is held open.
		yield* Effect.callback<void>((resume) => {
			setImmediate(() => resume(Effect.void));
		});
		assert.equal(manager.list([job.id])[0]?.status, "running");
		assert.equal(disposed, false);
		assertTerminalAlive();
		if (scenario === "queued-user") {
			assert.equal(
				abortCalls,
				0,
				"compaction must not invoke the TUI Escape handler",
			);
			assert.deepEqual(restoredToEditor, []);
			assert.ok(seenUserMessages.has("Include the revised figures"));
			assert.ok(seenUserMessages.has("Also write the appendix"));
		}
		assert.deepEqual(delivered, []);
		if (scenario === "cancel") {
			const [cancelled] = yield* manager.cancel([job.id]);
			assert.equal(cancelled?.status, "cancelled");
			assert.equal(compactionAborted, true);
			assert.equal(calls, 2);
			assert.deepEqual(delivered, []);
			return;
		}
		releaseCompaction.resolve();
		if (scenario === "continue") {
			yield* Effect.promise(() => continuation.promise);
			yield* Effect.callback<void>((resume) => {
				setImmediate(() => resume(Effect.void));
			});
			assert.equal(manager.list([job.id])[0]?.status, "running");
			assert.equal(disposed, false);
			assertTerminalAlive();
			assert.deepEqual(delivered, []);
			releaseContinuation.resolve();
		}
		yield* Effect.promise(() => settled.promise);
		const [result] = yield* manager.wait([job.id]);
		assert.equal(
			result?.status,
			scenario === "compaction-error" ? "error" : "done",
		);
		if (scenario === "continue")
			assert.equal(result?.output, "Report complete");
		assert.equal(
			calls,
			scenario === "continue" ? 3 : scenario === "queued-user" ? 4 : 2,
		);
		assert.deepEqual(delivered, [
			scenario === "compaction-error" ? "error" : "done",
		]);
	} finally {
		releaseContinuation.resolve();
		releaseCompaction.resolve();
		if (scenario !== "ordinary") yield* Effect.promise(() => compacted.promise);
		yield* manager.shutdown();
		yield* Effect.promise(() => session.waitForIdle());
		session.dispose();
		assert.ok(terminalPid);
		assert.ok(
			processIsGone(terminalPid),
			"child disposal must reap its server",
		);
		yield* Effect.promise(() => rm(cwd, { recursive: true, force: true }));
	}
});

for (const scenario of [
	"queued-user",
	"ordinary",
	"continue",
	"done",
	"ask-user",
	"cancel",
	"compaction-error",
	"handoff-aborted",
] as const) {
	test(`SDK compaction settlement: ${scenario}`, { timeout: 10000 }, () =>
		Effect.runPromise(runScenario(scenario)),
	);
}
