import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionEvent,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import tpsTracker from "../index.ts";

const waiting = "⏱ waiting for output...";

const agentEnd = { type: "agent_end", messages: [] } satisfies ExtensionEvent;

const requestStart = { type: "before_provider_request", payload: {} } as const;

function assistant(output: number) {
	const message = fauxAssistantMessage("Answer");

	return { ...message, usage: { ...message.usage, output } };
}

function harness(manager = SessionManager.inMemory()) {
	let now = 0;
	const statuses: Array<string | undefined> = [];

	const context = unsafeFixture<ExtensionContext>({
		sessionManager: manager,
		ui: unsafeFixture<ExtensionContext["ui"]>({
			theme: unsafeFixture<ExtensionContext["ui"]["theme"]>({
				fg: (_color, text) => text,
			}),
			setStatus: (_key, value) => statuses.push(value),
		}),
	});

	const adapter = extensionTestAdapter();
	tpsTracker(
		{
			...adapter.api,
			appendEntry: (type, data) => {
				manager.appendCustomEntry(type, data);
			},
		},
		{ now: () => now },
	);

	return {
		statuses,
		emit(event: ExtensionEvent, atMs = now) {
			now = atMs;

			return adapter.emit(event.type, event, context);
		},
	};
}

test("weights cumulative rates by request time across agent runs, excluding tools and idle gaps", async () => {
	const { emit, statuses } = harness();
	await emit({ type: "session_start", reason: "startup" });
	assert.equal(statuses.at(-1), waiting);
	await emit(requestStart, 1_000);
	await emit({ type: "message_end", message: assistant(100) }, 3_000);
	assert.equal(statuses.at(-1), "50.0 cumulative output tok/s");

	// Tool execution between requests must not affect the denominator.
	await emit(requestStart, 63_000);
	assert.equal(statuses.at(-1), "50.0 cumulative output tok/s");
	await emit({ type: "message_end", message: assistant(200) }, 71_000);
	assert.equal(statuses.at(-1), "30.0 cumulative output tok/s");
	await emit(agentEnd, 72_000);
	assert.equal(statuses.at(-1), "30.0 cumulative output tok/s");

	// Another user prompt must extend the totals, not reset them.
	await emit(requestStart, 180_000);
	assert.equal(statuses.at(-1), "30.0 cumulative output tok/s");
	await emit({ type: "message_end", message: assistant(10) }, 182_000);
	await emit(agentEnd, 182_000);
	assert.equal(statuses.at(-1), "25.8 cumulative output tok/s");
});

test("waits for one second of cumulative request time, retaining shorter measurements", async () => {
	const { emit, statuses } = harness();
	await emit({ type: "session_start", reason: "startup" });
	await emit(requestStart, 0);
	await emit({ type: "message_end", message: assistant(40) }, 250);
	await emit(agentEnd, 250);
	assert.equal(statuses.at(-1), waiting);

	await emit(requestStart, 5_000);
	await emit({ type: "message_end", message: assistant(60) }, 5_750);
	assert.equal(statuses.at(-1), "100.0 cumulative output tok/s");
});

test("unmeasured and zero-usage responses leave totals and the displayed rate unchanged", async () => {
	const { emit, statuses } = harness();
	await emit({ type: "session_start", reason: "startup" });
	await emit({ type: "message_end", message: assistant(100) }, 2_000);
	assert.equal(statuses.at(-1), waiting);

	await emit(requestStart, 3_000);
	await emit({ type: "message_end", message: assistant(100) }, 5_000);
	assert.equal(statuses.at(-1), "50.0 cumulative output tok/s");

	await emit(requestStart, 6_000);
	await emit(
		{
			type: "message_end",
			message: { ...assistant(0), stopReason: "aborted" },
		},
		16_000,
	);
	await emit(agentEnd, 16_000);
	assert.equal(statuses.at(-1), "50.0 cumulative output tok/s");

	await emit({ type: "message_end", message: assistant(900) }, 17_000);
	assert.equal(statuses.at(-1), "50.0 cumulative output tok/s");
	await emit(requestStart, 18_000);
	await emit({ type: "message_end", message: assistant(200) }, 26_000);
	assert.equal(statuses.at(-1), "30.0 cumulative output tok/s");
});

test("restoration excludes historical responses without timing and malformed measurements", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant(9_000));

	for (const data of [
		null,
		{ outputTokens: "100", durationMs: 2_000 },
		{ outputTokens: 100, durationMs: -1 },
		{ outputTokens: 100, durationMs: Number.POSITIVE_INFINITY },
		{ outputTokens: -100, durationMs: 2_000 },
	]) {
		manager.appendCustomEntry("tps-tracker-measurement", data);
	}

	manager.appendCustomEntry("another-extension", {
		outputTokens: 100,
		durationMs: 2_000,
	});

	const { emit, statuses } = harness(manager);
	await emit({ type: "session_start", reason: "resume" });
	assert.equal(statuses.at(-1), waiting);
	await emit(requestStart, 0);
	await emit({ type: "message_end", message: assistant(100) }, 2_000);
	await emit({ type: "session_start", reason: "reload" });
	assert.equal(statuses.at(-1), "50.0 cumulative output tok/s");
});

test("real sessions retain rates while streaming and restore the selected history across reloads, forks, and compaction", async (t) => {
	const { mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");
	const { tmpdir } = process.getBuiltinModule("node:os");
	const { join } = process.getBuiltinModule("node:path");
	const directory = mkdtempSync(join(tmpdir(), "pi-tps-tracker-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let now = 0;
	let status: string | undefined;
	let expectedWhileStreaming = waiting;
	let updates = 0;
	const notifications: string[] = [];
	const errors: string[] = [];

	const settingsManager = SettingsManager.inMemory({
		defaultProjectTrust: "always",
		compaction: { enabled: false },
		retry: { enabled: false },
	});

	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [(pi) => tpsTracker(pi, { now: () => now })],
	});

	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);

	const provider = fauxProvider({
		models: [{ id: "first" }, { id: "second" }],
	});

	const manager = SessionManager.create(directory, directory);

	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader: loader,
		settingsManager,
		sessionManager: manager,
		model: provider.getModel(),
		thinkingLevel: "off",
		noTools: "all",
	});

	t.after(() => session.dispose());

	await session.bindExtensions({
		mode: "tui",
		uiContext: unsafeFixture<ExtensionContext["ui"]>({
			theme: unsafeFixture<ExtensionContext["ui"]["theme"]>({
				fg: (_color, text) => text,
			}),
			setStatus: (_key, value) => {
				status = value;
			},
			notify: (message) => notifications.push(message),
		}),
		onError: (error) => errors.push(error.error),
	});
	session.modelRuntime.registerNativeProvider(provider.provider);
	session.subscribe((event) => {
		if (event.type === "agent_start" || event.type === "message_update") {
			assert.equal(status, expectedWhileStreaming);

			if (event.type === "message_update") updates++;
		}
	});

	for (const [durationMs, text] of [
		[2_000, "a".repeat(400)],
		[8_000, "b".repeat(800)],
	] as const) {
		provider.appendResponses([
			async (context, options, _state, model) => {
				// Faux streams do not call onPayload themselves; emulate that provider boundary.
				await options?.onPayload?.({}, model);
				assert.equal(status, expectedWhileStreaming);
				assert.doesNotMatch(
					JSON.stringify(context.messages),
					/tps-tracker-measurement/,
				);
				now += durationMs;

				return fauxAssistantMessage(text);
			},
		]);
	}

	await session.prompt("First request");
	assert.equal(status, "50.0 cumulative output tok/s");
	const firstResponseId = manager.getLeafId();
	assert.ok(firstResponseId);
	expectedWhileStreaming = status;
	now += 60_000;
	const secondModel = provider.getModel("second");
	assert.ok(secondModel);
	await session.setModel(secondModel);
	await session.prompt("Second request");
	assert.equal(status, "30.0 cumulative output tok/s");
	assert.ok(updates > 0);
	assert.deepEqual(errors, []);
	assert.deepEqual(notifications, []);

	const file = manager.getSessionFile();
	assert.ok(file);
	const reopened = SessionManager.open(file, directory);
	const restored = harness(reopened);
	await restored.emit({ type: "session_start", reason: "reload" });
	assert.equal(restored.statuses.at(-1), "30.0 cumulative output tok/s");

	const lastResponseId = reopened.getLeafId();
	assert.ok(lastResponseId);
	reopened.appendCompaction("Earlier history", lastResponseId, 1_000);
	await restored.emit({ type: "session_start", reason: "resume" });
	assert.equal(restored.statuses.at(-1), "30.0 cumulative output tok/s");

	reopened.branch(firstResponseId);
	await restored.emit({
		type: "session_tree",
		oldLeafId: lastResponseId,
		newLeafId: firstResponseId,
	});
	assert.equal(restored.statuses.at(-1), "50.0 cumulative output tok/s");
	reopened.createBranchedSession(firstResponseId);
	const forked = harness(reopened);
	await forked.emit({ type: "session_start", reason: "fork" });
	assert.equal(forked.statuses.at(-1), "50.0 cumulative output tok/s");
	await forked.emit(requestStart, 100_000);
	await forked.emit({ type: "message_end", message: assistant(20) }, 102_000);
	assert.equal(forked.statuses.at(-1), "30.0 cumulative output tok/s");

	reopened.newSession();
	await forked.emit({ type: "session_start", reason: "new" });
	assert.equal(forked.statuses.at(-1), waiting);
});
