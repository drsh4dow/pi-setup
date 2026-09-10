import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { unsafeFixture } from "../../test/adapter.ts";
import extension from "../index.ts";
import { anthropicOAuth } from "../oauth.ts";

test("overrides only Anthropic OAuth and preserves the built-in provider", () => {
	let registration: { name: string; config: ProviderConfig } | undefined;

	extension(
		unsafeFixture<ExtensionAPI>({
			registerProvider(name: string | Provider, config?: ProviderConfig) {
				assert.ok(config);
				assert.ok(name === "anthropic");
				registration = { name, config };
			},
		}),
	);

	assert.equal(registration?.name, "anthropic");
	assert.deepEqual(Object.keys(registration?.config ?? {}), ["oauth"]);
	assert.equal(registration?.config.oauth?.name, "Anthropic (Claude Pro/Max)");
	assert.equal(registration?.config.oauth?.usesCallbackServer, true);
	assert.equal(registration?.config.oauth, anthropicOAuth);
	assert.equal(
		registration?.config.oauth?.getApiKey({
			access: "test-access",
			refresh: "test-refresh",
			expires: 0,
		}),
		"test-access",
	);
});
