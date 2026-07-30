import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	fastServiceTier,
	shouldApplyFastMode,
	withFastServiceTier,
} from "../index.ts";

describe("gpt-fast-mode request mapping", () => {
	test("uses the canonical Fast tier on the public OpenAI API", () => {
		const model = { provider: "openai", id: "gpt-5.6-sol" };
		const payload = { model: model.id, input: "hello" };

		assert.equal(fastServiceTier(model), "fast");
		assert.equal(shouldApplyFastMode(model, payload), true);
		assert.deepEqual(withFastServiceTier(model, payload), {
			...payload,
			service_tier: "fast",
		});
	});

	test("uses Codex's catalog tier ID on the ChatGPT backend", () => {
		const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
		const payload = { model: model.id, input: "hello" };

		assert.equal(fastServiceTier(model), "priority");
		assert.equal(shouldApplyFastMode(model, payload), true);
		assert.deepEqual(withFastServiceTier(model, payload), {
			...payload,
			service_tier: "priority",
		});
	});

	test("does not tag models outside Codex's Fast catalog", () => {
		const model = { provider: "openai-codex", id: "gpt-5.4-mini" };
		const payload = { model: model.id, input: "hello" };

		assert.equal(fastServiceTier(model), undefined);
		assert.equal(shouldApplyFastMode(model, payload), false);
		assert.equal(withFastServiceTier(model, payload), payload);
	});

	test("does not tag a payload for a different model", () => {
		const model = { provider: "openai", id: "gpt-5.6-sol" };
		const payload = { model: "gpt-5.5", input: "hello" };

		assert.equal(shouldApplyFastMode(model, payload), false);
	});
});
