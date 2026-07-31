import assert from "node:assert/strict";
import { Deferred, Effect } from "effect";

export const yieldImmediate = Effect.callback<void>((resume) => {
	setImmediate(() => resume(Effect.void));
});

export function deferredPromise<A, E extends Error>(
	deferred: Deferred.Deferred<A, E>,
): Promise<A> {
	return Effect.runPromise(Deferred.await(deferred));
}

export function eventually(predicate: () => boolean) {
	return Effect.gen(function* () {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (predicate()) return;
			yield* Effect.sleep(1);
		}
		assert.fail("condition did not become true");
	});
}
