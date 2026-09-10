import assert from "node:assert/strict";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } =
	process.getBuiltinModule("fs");

import { tmpdir } from "node:os";

const { join } = process.getBuiltinModule("path");

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
import { BackgroundDelivery } from "../index.ts";
import { eventually } from "./eventually.ts";
import { snapshot } from "./snapshot.ts";

test("completed results steer after an active tool batch and wake an idle session", (t) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const directory = mkdtempSync(join(tmpdir(), "pi-delegate-delivery-"));
			t.after(() => rmSync(directory, { recursive: true, force: true }));
			const agentDir = join(directory, "agent");
			mkdirSync(agentDir);
			writeFileSync(join(agentDir, "settings.json"), "{}", "utf8");

			const toolStarted = Promise.withResolvers<void>();
			const toolGate = Promise.withResolvers<void>();
			let delivery: BackgroundDelivery | undefined;
			const loader = new DefaultResourceLoader({
				cwd: directory,
				agentDir,
				settingsManager: SettingsManager.inMemory({
					defaultProjectTrust: "always",
					compaction: { enabled: false },
					retry: { enabled: false },
				}),
				extensionFactories: [
					(pi) => {
						delivery = new BackgroundDelivery(pi, (results) =>
							Effect.succeed(results.map((result) => result.output).join("\n")),
						);
						pi.on("session_start", (_event, ctx) => delivery?.setContext(ctx));
						pi.registerTool({
							name: "gated_tool",
							label: "Gated Tool",
							description: "Wait for the test",
							parameters: Type.Object({}),
							executionMode: "parallel",
							execute() {
								toolStarted.resolve();
								return toolGate.promise.then(() => ({
									content: [{ type: "text" as const, text: "tool complete" }],
									details: {},
								}));
							},
						});
					},
				],
			});
			yield* Effect.promise(() => loader.reload());
			const provider = fauxProvider();
			const seenContexts: string[] = [];
			provider.setResponses([
				fauxAssistantMessage(fauxToolCall("gated_tool", {}), {
					stopReason: "toolUse",
				}),
				(context) => {
					seenContexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("active result received");
				},
			]);
			const { session } = yield* Effect.acquireRelease(
				Effect.promise(() =>
					createAgentSession({
						cwd: directory,
						agentDir,
						resourceLoader: loader,
						sessionManager: SessionManager.inMemory(directory),
						model: provider.getModel(),
						thinkingLevel: "off",
					}),
				),
				({ session }) => Effect.sync(() => session.dispose()),
			);
			yield* Effect.promise(() =>
				session.bindExtensions({
					mode: "print",
					onError: (error) => assert.fail(error.error),
				}),
			);
			session.modelRuntime.registerNativeProvider(provider.provider);
			session.setActiveToolsByName(["gated_tool"]);
			const prompt = session.prompt("Run the gated tool.");
			yield* Effect.promise(() => toolStarted.promise);
			assert.ok(delivery);
			delivery.enqueue(snapshot({ output: "ACTIVE DELIVERY MARKER" }));
			yield* Effect.yieldNow;
			toolGate.resolve();
			yield* Effect.promise(() => prompt);
			assert.match(seenContexts[0] ?? "", /ACTIVE DELIVERY MARKER/);
			assert.equal(session.getLastAssistantText(), "active result received");

			provider.appendResponses([
				(context) => {
					seenContexts.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("idle result received");
				},
			]);
			delivery.enqueue(
				snapshot({ id: "delegate-2", output: "IDLE DELIVERY MARKER" }),
			);
			yield* eventually(() => provider.state.callCount === 3);
			assert.match(seenContexts[1] ?? "", /IDLE DELIVERY MARKER/);
			assert.equal(session.getLastAssistantText(), "idle result received");
		}).pipe(Effect.scoped),
	));
