import assert from "node:assert/strict";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	SessionManager,
	type SessionMessageEntry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";
import sessionTimer from "../index.ts";

const firstUser = {
	type: "message",
	id: "first-user",
	parentId: null,
	timestamp: "1970-01-01T00:00:01.000Z",
	message: { role: "user", content: "Start", timestamp: 1000 },
} satisfies SessionMessageEntry;

function harness(
	manager: SessionManager,
	mode: ExtensionContext["mode"] = "tui",
) {
	const statuses: Array<string | undefined> = [];

	const context = unsafeFixture<ExtensionContext>({
		mode,
		sessionManager: manager,
		ui: unsafeFixture<ExtensionContext["ui"]>({
			theme: unsafeFixture<ExtensionContext["ui"]["theme"]>({
				fg: (_color, text) => text,
			}),
			setStatus: (_key, value) => statuses.push(value),
		}),
	});

	const adapter = extensionTestAdapter();
	sessionTimer({
		...adapter.api,
		registerEntryRenderer() {},
		appendEntry: (type, data) => {
			manager.appendCustomEntry(type, data);
		},
	});

	return { ...adapter, context, statuses };
}

test("restores selected-branch duration from completion times without backfilling footers", async () => {
	const manager = SessionManager.inMemory(undefined, undefined, [
		firstUser,
		{
			type: "message",
			id: "short",
			parentId: firstUser.id,
			timestamp: "1970-01-01T00:02:14.000Z",
			message: fauxAssistantMessage("Earlier response", { timestamp: 2000 }),
		},
		{
			type: "message",
			id: "hours",
			parentId: "short",
			timestamp: "1970-01-01T01:04:10.000Z",
			message: fauxAssistantMessage("Later response", { timestamp: 3000 }),
		},
		{
			type: "message",
			id: "days",
			parentId: "short",
			timestamp: "1970-01-03T03:04:10.000Z",
			message: fauxAssistantMessage("Other branch", { timestamp: 4000 }),
		},
		{
			type: "compaction",
			id: "compacted",
			parentId: "days",
			timestamp: "1970-01-04T00:00:00.000Z",
			summary: "Earlier history",
			firstKeptEntryId: "days",
			tokensBefore: 100,
		},
	]);

	const { emit, context, statuses } = harness(manager);
	await emit(
		"session_start",
		{ type: "session_start", reason: "resume" },
		context,
	);
	assert.equal(statuses.at(-1), "⏱ 2d 3h 04m 09s");

	for (const [id, expected] of [
		["hours", "⏱ 1h 4m 09s"],
		["short", "⏱ 2m 13s"],
		[firstUser.id, "⏱ 0s"],
	] as const) {
		const oldLeafId = manager.getLeafId();
		manager.branch(id);
		await emit(
			"session_tree",
			{ type: "session_tree", oldLeafId, newLeafId: id },
			context,
		);
		assert.equal(statuses.at(-1), expected);
	}

	assert.equal(manager.getEntries().length, 5);

	manager.resetLeaf();
	await emit(
		"session_start",
		{ type: "session_start", reason: "new" },
		context,
	);
	assert.equal(statuses.at(-1), undefined);
});

test("user submissions and produced tool results advance duration, including idle gaps", async () => {
	const manager = SessionManager.inMemory();
	const { emit, context, statuses } = harness(manager);
	await emit(
		"session_start",
		{ type: "session_start", reason: "startup" },
		context,
	);
	await emit(
		"message_start",
		{ type: "message_start", message: firstUser.message },
		context,
	);
	assert.equal(statuses.at(-1), "⏱ 0s");
	await emit(
		"message_start",
		{
			type: "message_start",
			message: { role: "user", content: "Continue", timestamp: 7_201_000 },
		},
		context,
	);
	assert.equal(statuses.at(-1), "⏱ 2h 0m 00s");
	await emit(
		"message_end",
		{
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "tool",
				toolName: "probe",
				content: [],
				isError: false,
				timestamp: 7_209_000,
			},
		},
		context,
	);
	assert.equal(statuses.at(-1), "⏱ 2h 0m 08s");
	await emit(
		"session_shutdown",
		{ type: "session_shutdown", reason: "reload" },
		context,
	);
	assert.equal(statuses.at(-1), undefined);
});

for (const mode of ["rpc", "json", "print"] as const) {
	test(`does not set terminal status in ${mode} mode`, async () => {
		const manager = SessionManager.inMemory(undefined, undefined, [firstUser]);
		const { emit, context, statuses } = harness(manager, mode);
		await emit(
			"session_start",
			{ type: "session_start", reason: "resume" },
			context,
		);
		await emit(
			"message_start",
			{ type: "message_start", message: firstUser.message },
			context,
		);
		await emit(
			"session_shutdown",
			{ type: "session_shutdown", reason: "quit" },
			context,
		);
		assert.deepEqual(statuses, []);
	});
}

test("real turns persist one display-only footer after each text response and restore it on reload", async (t) => {
	const { mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");
	const { tmpdir } = process.getBuiltinModule("node:os");
	const { join } = process.getBuiltinModule("node:path");
	const directory = mkdtempSync(join(tmpdir(), "pi-session-timer-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));

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
		extensionFactories: [
			sessionTimer,
			(pi) =>
				pi.registerTool({
					name: "probe",
					label: "Probe",
					description: "Return a tool result",
					parameters: Type.Object({}),
					execute: () =>
						Promise.resolve({
							content: [{ type: "text", text: "tool output" }],
							details: {},
						}),
				}),
		],
	});

	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const provider = fauxProvider();
	const manager = SessionManager.create(directory, directory);
	manager.appendMessage(firstUser.message);

	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader: loader,
		settingsManager,
		sessionManager: manager,
		model: provider.getModel(),
		thinkingLevel: "off",
	});

	t.after(() => session.dispose());
	const errors: string[] = [];
	let status: string | undefined;

	const theme = unsafeFixture<ExtensionContext["ui"]["theme"]>({
		fg: (_color, text) => text,
	});

	await session.bindExtensions({
		mode: "tui",
		uiContext: unsafeFixture<ExtensionContext["ui"]>({
			theme,
			setStatus: (_key, value) => {
				status = value;
			},
		}),
		onError: (error) => errors.push(error.error),
	});
	session.modelRuntime.registerNativeProvider(provider.provider);
	session.setActiveToolsByName(["probe"]);
	provider.setResponses([
		fauxAssistantMessage(
			[
				fauxText("Checking"),
				fauxToolCall("probe", {}),
				fauxToolCall("probe", {}),
			],
			{ stopReason: "toolUse", timestamp: 2000 },
		),
		fauxAssistantMessage(fauxToolCall("probe", {}), {
			stopReason: "toolUse",
			timestamp: 3000,
		}),
		fauxAssistantMessage("Done", { timestamp: 4000 }),
	]);
	await session.prompt("Continue");
	assert.equal(session.getLastAssistantText(), "Done");
	assert.match(status ?? "", /^⏱ \d+d /);

	const entries = manager.getBranch();
	const moments = entries.filter((entry) => entry.type === "custom");
	assert.equal(moments.length, 2);

	for (const moment of moments) {
		assert.equal(moment.customType, "session-timer-moment");
		assert.ok(moment.parentId);
		const response = manager.getEntry(moment.parentId);
		assert.equal(response?.type, "message");
		assert.ok(
			response?.type === "message" && response.message.role === "assistant",
		);
		assert.equal(
			moment.data,
			Date.parse(response.timestamp) - firstUser.message.timestamp,
		);

		const renderer = session.extensionRunner.getEntryRenderer(
			moment.customType,
		);

		assert.ok(renderer);

		const footer = renderer(
			{ ...moment, data: 133_000 },
			{ expanded: false },
			theme,
		);

		assert.equal(footer?.render(80).join("\n").trim(), "⏱ 2m 13s");
		assert.equal(
			renderer({ ...moment, data: "invalid" }, { expanded: false }, theme),
			undefined,
		);
	}

	provider.setResponses([
		(context) => {
			assert.deepEqual(
				context.messages.map((message) => message.role),
				[
					"user",
					"user",
					"assistant",
					"toolResult",
					"toolResult",
					"assistant",
					"toolResult",
					"assistant",
					"user",
				],
			);
			assert.doesNotMatch(
				JSON.stringify(context.messages),
				/⏱|session-timer-moment/,
			);

			return fauxAssistantMessage([
				fauxThinking("No visible text"),
				fauxText("  "),
			]);
		},
	]);
	await session.prompt("Think only");
	assert.deepEqual(errors, []);

	const file = manager.getSessionFile();
	assert.ok(file);
	const reopened = SessionManager.open(file, directory);
	assert.deepEqual(
		reopened.getEntries().filter((entry) => entry.type === "custom"),
		moments,
	);
	const { emit, context, statuses } = harness(reopened);
	await emit(
		"session_start",
		{ type: "session_start", reason: "reload" },
		context,
	);
	assert.match(statuses.at(-1) ?? "", /^⏱ /);
	assert.deepEqual(
		reopened.getEntries().filter((entry) => entry.type === "custom"),
		moments,
	);
});
