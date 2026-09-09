import assert from "node:assert/strict";
import test from "node:test";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { resolveDelegateModel, resolveRequestedModel } from "../runtime.ts";

test("logical Codex delegates accept account aliases without an original login", () => {
	const logical = openaiCodexProvider()
		.getModels()
		.find((model) => model.id === "gpt-5.4");
	assert.ok(logical);
	const alias = { ...logical, provider: "openai-codex@A" };
	const context = {
		model: alias,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === logical.provider && id === logical.id
					? logical
					: undefined,
			hasConfiguredAuth: () => false,
			getAvailable: () => [alias],
		},
	};
	const explicit = resolveRequestedModel(context, "openai-codex/gpt-5.4");
	assert.equal(explicit.model?.provider, "openai-codex");
	assert.equal(explicit.model?.id, "gpt-5.4");
	const configured = resolveDelegateModel(context, {
		model: "openai-codex/gpt-5.4",
	});
	assert.equal(configured.model?.provider, "openai-codex");
	assert.equal(configured.fallbackReason, undefined);
	assert.throws(
		() =>
			resolveRequestedModel(
				{
					...context,
					modelRegistry: { ...context.modelRegistry, getAvailable: () => [] },
				},
				"openai-codex/gpt-5.4",
			),
		/has no auth configured/,
	);
});
