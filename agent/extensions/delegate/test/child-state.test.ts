import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ChildState } from "../child-state.ts";

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "test",
		model: "test",
		timestamp: 0,
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function update(state: ChildState, text: string) {
	const partial = message(text);
	state.capture({
		type: "message_update",
		message: partial,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: "",
			partial,
		},
	});
}

test("streamed trail preserves Unicode across a split surrogate pair", () => {
	const state = new ChildState();
	update(state, `head ${"é".repeat(3000)} tail \ud83d`);
	assert.doesNotMatch(state.trail().join(""), /�|[\ud800-\udfff]/u);
	update(state, `head ${"é".repeat(3000)} tail 😀`);
	assert.match(state.trail()[0], /^Assistant \(writing\)\n\nhead /);
	assert.match(state.trail()[0], /\[message truncated\]/);
	assert.match(state.trail()[0], /tail 😀$/u);
	assert.ok(Buffer.byteLength(state.trail()[0]) <= 4096 + 32);
	const final = message("authoritative final text");
	state.capture({ type: "message_end", message: final });
	assert.deepEqual(state.trail(), ["Assistant\n\nauthoritative final text"]);
	assert.equal(state.state().output, "authoritative final text");
	assert.equal(state.state().progress, "said: authoritative final text");
});

test("streamed progress collapses whitespace and resets for the next message", () => {
	const state = new ChildState();
	update(state, " \n first \t");
	assert.equal(state.state().progress, "writing: first");
	update(state, " \n first \t second");
	assert.equal(state.state().progress, "writing: first second");
	state.capture({ type: "message_end", message: message("first second") });
	state.capture({ type: "message_start", message: message("") });
	update(state, "new response");
	assert.equal(state.state().progress, "writing: new response");
	assert.deepEqual(state.trail(), [
		"Assistant\n\nfirst second",
		"Assistant (writing)\n\nnew response",
	]);
});

test("streamed multipart messages trim each text part and omit thinking", () => {
	const state = new ChildState();
	const partial = message("");
	partial.content = [
		{ type: "text", text: "  first  " },
		{ type: "thinking", thinking: "private" },
		{ type: "text", text: " \n " },
		{ type: "text", text: " second " },
	];
	state.capture({ type: "message_start", message: partial });
	assert.deepEqual(state.trail(), ["Assistant (writing)\n\nfirst\nsecond"]);
	assert.equal(state.state().progress, "writing: first second");
});

test("separated text blocks and non-text updates preserve the same bounded preview", () => {
	const state = new ChildState();
	const first = message(`  head ${"😀".repeat(1200)} \n`);
	state.capture({ type: "message_start", message: first });
	const partial = message("");
	partial.content = [
		...first.content,
		{ type: "thinking", thinking: "not displayed" },
		{ type: "text", text: ` \t${"é".repeat(3000)} tail \n` },
	];
	state.capture({
		type: "message_update",
		message: partial,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 2,
			delta: " tail \n",
			partial,
		},
	});
	const writing = state.trail()[0];
	assert.match(writing, /^Assistant \(writing\)\n\nhead 😀/u);
	assert.match(writing, /é tail$/u);
	assert.doesNotMatch(writing, /�|[\ud800-\udfff]|not displayed/u);
	assert.ok(Buffer.byteLength(writing) <= 4096 + 32);
	const progress = state.state().progress;
	state.capture({
		type: "message_update",
		message: partial,
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 1,
			delta: "more thinking",
			partial,
		},
	});
	assert.deepEqual(state.trail(), [writing]);
	assert.equal(state.state().progress, progress);
	state.capture({ type: "message_end", message: partial });
	assert.equal(
		state.trail()[0],
		writing.replace("Assistant (writing)", "Assistant"),
	);
	assert.equal(
		state.state().output,
		`head ${"😀".repeat(1200)}\n${"é".repeat(3000)} tail`,
	);
});

test("long streamed whitespace stays trimmed until later text makes it internal", () => {
	const state = new ChildState();
	update(state, " \t".repeat(5000));
	assert.deepEqual(state.trail(), []);
	update(state, `${" \t".repeat(5000)}first${" \n".repeat(5000)}`);
	assert.deepEqual(state.trail(), ["Assistant (writing)\n\nfirst"]);
	update(state, `${" \t".repeat(5000)}first${" \n".repeat(5000)}second`);
	assert.match(state.trail()[0], /^Assistant \(writing\)\n\nfirst/);
	assert.match(state.trail()[0], /second$/);
	assert.match(state.trail()[0], /\[message truncated\]/);
	assert.equal(state.state().progress, "writing: first second");
});
