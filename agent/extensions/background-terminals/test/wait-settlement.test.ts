import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { BackgroundTerminalDelivery } from "../delivery.ts";
import {
	type BackgroundTerminalSession,
	joinBackgroundTerminalSession,
} from "../session.ts";

for (const outcome of ["cancel", "success", "one-of-two-cancelled"] as const) {
	test(`wait settlement delivery: ${outcome}`, { timeout: 5000 }, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const owner = Symbol(outcome);
				const controller = new AbortController();
				const messages: unknown[] = [];
				let idle = false;
				let session: BackgroundTerminalSession | undefined;
				let id: string | undefined;
				let cancellationAtSettlement = false;
				const delivery = new BackgroundTerminalDelivery({
					sendMessage(message) {
						messages.push(message);
					},
				});
				delivery.setContext({ isIdle: () => idle } as ExtensionContext);
				session = joinBackgroundTerminalSession(owner, {
					delivery,
					updateStatus() {
						if (
							id &&
							session?.get(owner, id)?.state === "done" &&
							outcome !== "success"
						) {
							// This is the actual onSettled callback, before Deferred.succeed.
							cancellationAtSettlement = true;
							controller.abort();
						}
					},
				});
				const activeSession = session;
				try {
					const started = session.start(owner, {
						command: "printf settled",
						title: outcome,
						cwd: process.cwd(),
					});
					id = started.id;
					// Same success boundary as bg_wait: consume only after wait returns.
					const wait = Effect.gen(function* () {
						const snapshot = yield* activeSession.wait(owner, started.id);
						activeSession.consume(owner, [snapshot.id]);
						return snapshot;
					});
					const pending = Effect.runPromise(wait, {
						signal: controller.signal,
					});
					const second =
						outcome === "one-of-two-cancelled"
							? Effect.runPromise(wait)
							: undefined;
					if (outcome === "success") {
						assert.equal(
							(yield* Effect.promise(() => pending)).stdout.text,
							"settled",
						);
					} else {
						yield* Effect.promise(() => assert.rejects(pending));
						assert.equal(cancellationAtSettlement, true);
					}
					if (second)
						assert.equal(
							(yield* Effect.promise(() => second)).stdout.text,
							"settled",
						);
					assert.equal(session.get(owner, started.id)?.state, "done");
					assert.equal(
						messages.length,
						0,
						"tool execution keeps delivery queued",
					);
					idle = true;
					yield* delivery.flush;
					assert.equal(messages.length, outcome === "cancel" ? 1 : 0);
					yield* delivery.flush;
					assert.equal(messages.length, outcome === "cancel" ? 1 : 0);
				} finally {
					yield* session.leave(owner);
				}
			}),
		),
	);
}
