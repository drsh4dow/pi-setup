import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionDuration } from "../accounting.ts";
import { usageView } from "./usage-fixture.ts";

test("cost, elapsed time, and context share one dim footer line", () => {
	const parent = SessionManager.inMemory(process.cwd());
	const header = parent.getHeader();
	assert.ok(header);
	header.timestamp = "2026-01-01T10:00:00.000Z";
	parent.appendMessage({
		role: "assistant",
		content: [],
		timestamp: 0,
		api: "test",
		provider: "test",
		model: "test",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const entries = parent.getEntries();
	assert.ok(entries[0]);
	entries[0].timestamp = "2026-01-01T11:02:03.000Z";
	parent.appendCustomEntry("later-metadata", {});
	const view = usageView(parent, "kimi-coding");
	try {
		const lines = stripVTControlCharacters(view.render()).split("\n");
		assert.equal(lines.length, 2);
		assert.equal(
			lines[1]?.trimEnd().replace(/ +test-model$/, ""),
			"USD 0.000 (sub) · 1h 2m 3s · 10.0%/1.0k",
		);
		assert.equal(view.render().split("\n")[1]?.startsWith("\x1b[90mUSD"), true);
		assert.equal(sessionDuration(header.timestamp, []), "0s");
		assert.equal(sessionDuration("invalid", entries), "?");
		assert.equal(sessionDuration("2026-01-02T00:00:00Z", entries), "0s");
	} finally {
		view.dispose();
	}
});
