import assert from "node:assert/strict";
import { Effect } from "effect";

export function eventually(predicate: () => boolean) {
	return Effect.gen(function* () {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (predicate()) return;
			yield* Effect.sleep(1);
		}
		assert.fail("condition did not become true");
	});
}
