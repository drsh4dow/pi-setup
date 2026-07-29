import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

test("overrides only Anthropic OAuth and preserves the built-in provider", () => {
	let registration: { name: string; config: ProviderConfig } | undefined;

	extension({
		registerProvider(name, config) {
			registration = { name, config };
		},
	} as ExtensionAPI);

	assert.equal(registration?.name, "anthropic");
	assert.deepEqual(Object.keys(registration?.config ?? {}), ["oauth"]);
	assert.equal(registration?.config.oauth?.name, "Anthropic (Claude Pro/Max)");
	assert.equal(registration?.config.oauth?.usesCallbackServer, true);
	assert.equal(typeof registration?.config.oauth?.login, "function");
	assert.equal(typeof registration?.config.oauth?.refreshToken, "function");
	assert.equal(typeof registration?.config.oauth?.getApiKey, "function");
});
