import assert from "node:assert/strict";
import test from "node:test";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexAccounts, { codexAliasProvider } from "../index.ts";

test("alias provider re-stamps the built-in codex catalog", () => {
	const base = openaiCodexProvider();
	const alias = codexAliasProvider("cyber");

	assert.equal(alias.id, "openai-codex-cyber");
	assert.equal(alias.name, "OpenAI Codex (cyber)");
	assert.equal(alias.baseUrl, base.baseUrl);

	const models = alias.getModels();
	assert.ok(models.length > 0);
	for (const model of models) {
		assert.equal(model.provider, "openai-codex-cyber");
	}
	assert.deepEqual(
		models.map((model) => model.id),
		base.getModels().map((model) => model.id),
	);

	assert.ok(alias.auth.oauth);
	assert.equal(alias.auth.oauth.isSubscription, true);
	assert.match(alias.auth.oauth.name, /cyber/);
});

test("extension registers one provider per account label", () => {
	const registered: string[] = [];
	codexAccounts({
		registerProvider: (provider: { id: string }) =>
			registered.push(provider.id),
	} as unknown as ExtensionAPI);
	assert.deepEqual(registered, ["openai-codex-cyber"]);
});
