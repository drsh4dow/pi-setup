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
import { Deferred, Effect } from "effect";
import compactionExtension from "../../compaction/index.ts";
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
	let calls = 0;
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
		streamSimple: (model) => {
			calls++;
			const text =
				calls === 1
					? "Working on the report"
					: calls === 2
						? `## Handoff\n- Objective: write report\n- Continuation: ${scenario === "cancel" ? "continue" : scenario}`
						: "Report complete";
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason:
					calls === 2 && scenario === "handoff-aborted" ? "aborted" : "stop",
				timestamp: 1,
				usage: {
					input: calls < 3 ? 8600 : 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: calls < 3 ? 8620 : 120,
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
			if (calls === 3) {
				continuation.resolve();
				void releaseContinuation.promise.then(() =>
					stream.push({ type: "done", reason: "stop", message }),
				);
			} else if (message.stopReason === "aborted")
				stream.push({ type: "error", reason: "aborted", error: message });
			else stream.push({ type: "done", reason: "stop", message });
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
			noTools: "all",
		}),
	);
	yield* Effect.promise(() =>
		session.bindExtensions({
			mode: "print",
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
			return Effect.runPromiseWith(services)(shutdownChild(session));
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
		assert.equal(calls, scenario === "continue" ? 3 : 2);
		assert.deepEqual(delivered, [
			scenario === "compaction-error" ? "error" : "done",
		]);
	} finally {
		releaseContinuation.resolve();
		releaseCompaction.resolve();
		yield* Effect.promise(() => compacted.promise);
		yield* manager.shutdown();
		yield* Effect.promise(() => session.waitForIdle());
		session.dispose();
		yield* Effect.promise(() => rm(cwd, { recursive: true, force: true }));
	}
});

for (const scenario of [
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
