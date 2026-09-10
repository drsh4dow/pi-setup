import assert from "node:assert/strict";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionManager,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { unsafeFixture } from "../../test/adapter.ts";
import extension from "../index.ts";

export function querySessionUsage(sessionManager: SessionManager) {
	let tool: Pick<ToolDefinition, "execute"> | undefined;

	const pi = unsafeFixture<ExtensionAPI>({
		events: { emit() {}, on: () => () => {} },
		on() {},
		registerTool(value) {
			tool = value;
		},
		registerEntryRenderer() {},
		registerCommand() {},
	});

	extension(pi);
	assert.ok(tool);
	const context = unsafeFixture<ExtensionContext>({ sessionManager });

	return tool.execute("usage", {}, undefined, undefined, context);
}
