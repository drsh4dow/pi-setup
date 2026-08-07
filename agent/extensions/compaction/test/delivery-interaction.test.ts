import assert from "node:assert/strict";

const { mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("fs");
const { join } = process.getBuiltinModule("path");

import { tmpdir } from "node:os";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { BackgroundDelivery } from "../../delegate/index.ts";
import { snapshot } from "../../delegate/test/snapshot.ts";
import compactionExtension, {
	COMPACTION_DELIVERY_PAUSE_CHANNEL,
} from "../index.ts";

const HANDOFF = `## Handoff
- **Objective:** reproduce compaction
- **Stance:** test — executing
- **Done:** setup
- **In progress:** waiting
- **Next action:** continue
- **Do not:** none
- **Re-read:** none
- **Continuation:** continue`;

test("compacts a handoff before processing a background result", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const services = yield* Effect.context<never>();
			const directory = mkdtempSync(join(tmpdir(), "pi-compaction-delivery-"));
			writeFileSync(
				join(directory, "settings.json"),
				'{"compaction":{"enabled":true,"reserveTokens":100,"keepRecentTokens":10}}',
			);
			const faux = fauxProvider({
				models: [{ id: "faux-1", contextWindow: 900, maxTokens: 100 }],
			});
			const order: string[] = [];
			faux.setResponses([
				fauxAssistantMessage("cross boundary"),
				fauxAssistantMessage(HANDOFF),
				() => {
					order.push("next-turn");
					return fauxAssistantMessage("continued");
				},
				() => {
					order.push("background-turn");
					return fauxAssistantMessage("processed result");
				},
			]);
			const modelRuntime = yield* Effect.promise(() =>
				ModelRuntime.create({ modelsPath: null }),
			);
			modelRuntime.registerNativeProvider(faux.provider);
			const resourceLoader = new DefaultResourceLoader({
				cwd: directory,
				agentDir: directory,
				extensionFactories: [
					(pi) => compactionExtension(pi, () => true),
					(pi) => {
						const delivery = new BackgroundDelivery(pi, () =>
							Effect.succeed("delegate finished"),
						);
						let handoffWritten = false;
						let enqueued = false;
						pi.events.on(COMPACTION_DELIVERY_PAUSE_CHANNEL, (paused) => {
							if (typeof paused === "boolean") delivery.setPaused(paused);
						});
						pi.on("session_start", (_event, context) =>
							delivery.setContext(context),
						);
						pi.on("turn_end", (event) => {
							handoffWritten ||=
								event.message.role === "assistant" &&
								event.message.content.some(
									(part) =>
										part.type === "text" && part.text.includes("## Handoff"),
								);
						});
						pi.on("agent_settled", () => {
							if (handoffWritten && !enqueued) {
								enqueued = true;
								delivery.enqueue(
									snapshot({
										id: "delegate-1",
										status: "done",
										output: "done",
									}),
								);
							}
							return Effect.runPromiseWith(services)(delivery.flush());
						});
					},
				],
			});
			yield* Effect.promise(() => resourceLoader.reload());
			const { session } = yield* Effect.promise(() =>
				createAgentSession({
					cwd: directory,
					agentDir: directory,
					modelRuntime,
					model: faux.getModel(),
					resourceLoader,
					sessionManager: SessionManager.inMemory(directory),
					noTools: "all",
				}),
			);
			yield* Effect.promise(() => session.bindExtensions({ mode: "print" }));
			session.subscribe((event) => {
				if (event.type === "compaction_end" && !event.aborted)
					order.push("compaction");
			});

			try {
				void session.prompt("start");
				for (let attempt = 0; attempt < 100 && order.length < 3; attempt++)
					yield* Effect.sleep(10);
				assert.deepEqual(order.slice(0, 3), [
					"compaction",
					"next-turn",
					"background-turn",
				]);
			} finally {
				yield* Effect.promise(() => session.abort());
				session.dispose();
				rmSync(directory, { recursive: true, force: true });
			}
		}),
	));
