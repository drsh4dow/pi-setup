import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Deferred, Effect } from "effect";
import type { DelegateSnapshot } from "../contract.ts";
import { BackgroundDelivery } from "../index.ts";
import { snapshot } from "./snapshot.ts";

function delegateSnapshot(overrides: Partial<DelegateSnapshot> = {}) {
	return snapshot({
		status: "done",
		output: "background result",
		success: true,
		assignedTask: "fixture",
		settledAt: 1,
		...overrides,
	});
}

function waitUntil(predicate: () => boolean, attempts = 500) {
	return Effect.gen(function* () {
		for (let attempt = 0; attempt < attempts && !predicate(); attempt++) {
			yield* Effect.sleep(1);
		}
		assert.equal(predicate(), true, "condition did not become true");
	});
}

test("coalesces ready results and steers without an idle gate", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const sent: Array<{ message: unknown; options: unknown }> = [];
			const delivery = new BackgroundDelivery({
				sendMessage(message: unknown, options: unknown) {
					sent.push({ message, options });
				},
			} as unknown as ExtensionAPI);
			delivery.setContext({} as ExtensionContext);
			delivery.enqueue(delegateSnapshot({ output: "first child" }));
			delivery.enqueue(
				delegateSnapshot({
					id: "delegate-2",
					output: "second child",
					fullOutputFile: "/tmp/complete-second-child.txt",
				}),
			);

			yield* waitUntil(() => sent.length === 1);
			assert.deepEqual(sent[0].options, {
				deliverAs: "steer",
				triggerTurn: true,
			});
			const message = sent[0].message as {
				content: string;
				details: { ids: string[] };
			};
			assert.deepEqual(message.details.ids, ["delegate-1", "delegate-2"]);
			assert.match(message.content, /first child/);
			assert.match(message.content, /second child/);
			assert.match(message.content, /\/tmp\/complete-second-child\.txt/);
			yield* delivery.flush();
			assert.equal(sent.length, 1);
		}),
	));

test("retries transient render and send failures while the parent is active", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			let renders = 0;
			let sends = 0;
			const sent: unknown[] = [];
			const delivery = new BackgroundDelivery(
				{
					sendMessage(message: unknown) {
						sends++;
						if (sends === 1) throw new Error("temporary send failure");
						sent.push(message);
					},
				} as unknown as ExtensionAPI,
				(snapshots) => {
					renders++;
					return renders === 1
						? Effect.die(new Error("temporary render failure"))
						: Effect.succeed(snapshots.map((item) => item.output).join(","));
				},
			);
			delivery.setContext({} as ExtensionContext);
			delivery.enqueue(delegateSnapshot({ output: "eventual result" }));

			yield* waitUntil(() => sent.length === 1);
			assert.equal(renders, 3);
			assert.equal(sends, 2);
			assert.match((sent[0] as { content: string }).content, /eventual result/);
		}),
	));

test("consume and clear suppress retries without suppressing later results", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const attempts: string[][] = [];
			const sent: unknown[] = [];
			const delivery = new BackgroundDelivery(
				{
					sendMessage(message: unknown) {
						const ids = (message as { details: { ids: string[] } }).details.ids;
						attempts.push(ids);
						if (ids.includes("delegate-1"))
							throw new Error("temporary failure");
						sent.push(message);
					},
				} as unknown as ExtensionAPI,
				(items) => Effect.succeed(items.map((item) => item.output).join(",")),
			);
			delivery.setContext({} as ExtensionContext);
			const cancelled = delegateSnapshot({ output: "cancelled result" });
			delivery.enqueue(cancelled);
			yield* waitUntil(() => attempts.length === 1);
			delivery.consume([cancelled]);
			delivery.enqueue(
				delegateSnapshot({ id: "delegate-2", output: "later result" }),
			);

			yield* waitUntil(() => sent.length === 1);
			assert.deepEqual(attempts, [["delegate-1"], ["delegate-2"]]);
			assert.doesNotMatch(
				(sent[0] as { content: string }).content,
				/cancelled result/,
			);
			assert.match((sent[0] as { content: string }).content, /later result/);

			let clearedAttempts = 0;
			const cleared = new BackgroundDelivery(
				{
					sendMessage() {
						clearedAttempts++;
						throw new Error("temporary failure");
					},
				} as unknown as ExtensionAPI,
				() => Effect.succeed("result"),
			);
			cleared.setContext({} as ExtensionContext);
			cleared.enqueue(delegateSnapshot());
			yield* waitUntil(() => clearedAttempts === 1);
			cleared.clear();
			yield* Effect.sleep(40);
			assert.equal(clearedAttempts, 1);
		}),
	));

test("a stale failure does not consume or charge a replacement snapshot", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const firstRender = yield* Deferred.make<never>();
			const sent: unknown[] = [];
			let renders = 0;
			const delivery = new BackgroundDelivery(
				{ sendMessage: (message: unknown) => sent.push(message) },
				(items) => {
					renders++;
					return renders === 1
						? Deferred.await(firstRender)
						: Effect.succeed(items.map((item) => item.output).join(","));
				},
			);
			delivery.setContext({} as ExtensionContext);
			delivery.enqueue(delegateSnapshot({ output: "stale result" }));
			yield* waitUntil(() => renders === 1);
			delivery.enqueue(delegateSnapshot({ output: "replacement result" }));
			yield* Deferred.die(firstRender, new Error("stale render failure"));

			yield* waitUntil(() => sent.length === 1);
			assert.equal(renders, 2);
			assert.match(
				(sent[0] as { content: string }).content,
				/replacement result/,
			);
			assert.doesNotMatch(
				(sent[0] as { content: string }).content,
				/stale result/,
			);
		}),
	));

test("exhausted delivery remains pending without blocking newer results", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const attempts = new Map<string, number>();
			const acknowledged: string[][] = [];
			const sent: unknown[] = [];
			const originalLog = console.log;
			console.log = () => {};
			const delivery = new BackgroundDelivery(
				{
					sendMessage(message: unknown) {
						const ids = (message as { details: { ids: string[] } }).details.ids;
						for (const id of ids) attempts.set(id, (attempts.get(id) ?? 0) + 1);
						if (ids.includes("delegate-1")) throw new Error("offline");
						sent.push(message);
					},
				} as unknown as ExtensionAPI,
				(items) => Effect.succeed(items.map((item) => item.id).join(",")),
				(ids) => acknowledged.push([...ids]),
			);
			try {
				delivery.setContext({} as ExtensionContext);
				delivery.enqueue(delegateSnapshot());
				yield* waitUntil(() => attempts.get("delegate-1") === 3);
				assert.deepEqual(acknowledged, []);

				delivery.enqueue(delegateSnapshot({ id: "delegate-2" }));
				yield* waitUntil(() => sent.length === 1);
				assert.equal(attempts.get("delegate-1"), 3);
				assert.equal(attempts.get("delegate-2"), 1);
				assert.deepEqual(acknowledged, [["delegate-2"]]);
			} finally {
				delivery.clear();
				console.log = originalLog;
			}
		}),
	));
