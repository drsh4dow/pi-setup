import assert from "node:assert/strict";
import { Effect } from "effect";

export async function eventually(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Effect.runPromise(Effect.sleep(1));
	}
	assert.fail("condition did not become true");
}
