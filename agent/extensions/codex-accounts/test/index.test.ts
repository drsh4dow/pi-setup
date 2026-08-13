import assert from "node:assert/strict";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexAccounts, { codexAliasProvider } from "../index.ts";

test("cyber alias adds Daybreak Blue and re-stamps model providers", () => {
	const base = builtinProviders().find(
		(provider) => provider.id === "openai-codex",
	);
	assert.ok(base);
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
		models.slice(0, -1).map((model) => model.id),
		base.getModels().map((model) => model.id),
	);
	const daybreak = models.at(-1);
	assert.equal(daybreak?.id, "gpt-daybreak-blue-latest");
	assert.equal(daybreak?.name, "Daybreak Blue");
	assert.deepEqual(
		codexAliasProvider("other")
			.getModels()
			.map((model) => model.id),
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
