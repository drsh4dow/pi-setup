import assert from "node:assert/strict";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import extension from "../index.ts";

const { mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");
const { tmpdir } = process.getBuiltinModule("node:os");
const { join } = process.getBuiltinModule("node:path");

// Busy work that outlasts the background command so the result arrives
// while a tool call is still executing.
const independentWork = () =>
	Effect.runPromise(
		Effect.sleep(500).pipe(
			Effect.as({
				content: [{ type: "text" as const, text: "independent work finished" }],
				details: {},
			}),
		),
	);

test("a finished background command reaches the model before its next call, not after the run", (t) =>
	Effect.gen(function* () {
		const directory = mkdtempSync(join(tmpdir(), "pi-bg-steering-"));
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
				extension,
				(pi) =>
					pi.registerTool({
						name: "independent_work",
						label: "Independent work",
						description: "Busy work that keeps the agent run busy",
						parameters: Type.Object({}),
						execute: independentWork,
					}),
			],
		});
		yield* Effect.promise(() => loader.reload());
		assert.deepEqual(loader.getExtensions().errors, []);

		const provider = fauxProvider();
		const { session } = yield* Effect.acquireRelease(
			Effect.promise(() =>
				createAgentSession({
					cwd: directory,
					agentDir: directory,
					resourceLoader: loader,
					settingsManager,
					sessionManager: SessionManager.inMemory(directory),
					model: provider.getModel(),
					thinkingLevel: "off",
				}),
			),
			({ session }) => Effect.sync(() => session.dispose()),
		);

		const errors: string[] = [];
		yield* Effect.promise(() =>
			session.bindExtensions({
				mode: "print",
				onError: (error) => errors.push(error.error),
			}),
		);
		assert.deepEqual(errors, []);
		session.modelRuntime.registerNativeProvider(provider.provider);
		session.setActiveToolsByName(["bg_start", "independent_work"]);

		// Message history seen by the final model call.
		let finalContext:
			| { messages: Array<{ role: string; content: unknown }> }
			| undefined;
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall("bg_start", {
					command: "sleep 0.1; printf 'background output'; exit 23",
					title: "steering probe",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("independent_work", {}), {
				stopReason: "toolUse",
			}),
			(context) => {
				finalContext = context;
				return fauxAssistantMessage("ack");
			},
		]);

		yield* Effect.promise(() =>
			session.prompt("Start the background command, then do independent work."),
		);
		yield* Effect.promise(() => session.waitForIdle());

		// Three model calls only: the run ended on its own final answer. A
		// post-run follow-up turn would need a fourth call.
		assert.equal(provider.state.callCount, 3);
		assert.equal(session.getLastAssistantText(), "ack");

		const messages = finalContext?.messages ?? [];
		const resultIndex = messages.findIndex((message) => {
			if (message.role !== "user") return false;
			const text = JSON.stringify(message.content);
			return text.includes("exit 23") && text.includes("background output");
		});
		assert.ok(
			resultIndex !== -1,
			"background result missing from the final model call",
		);
		assert.ok(
			messages
				.slice(0, resultIndex)
				.some((message) => message.role === "toolResult"),
			"background result must follow the tool results",
		);
	}).pipe(Effect.scoped, Effect.runPromise));
