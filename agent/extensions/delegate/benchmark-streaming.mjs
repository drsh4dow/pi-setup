// node agent/extensions/delegate/benchmark-streaming.mjs [path/to/child-state.ts]
// An optional module path measures the old implementation without asserting its scaling.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const baseline = process.argv[2];
const { ChildState } = await import(
	baseline
		? pathToFileURL(resolve(baseline)).href
		: new URL("./child-state.ts", import.meta.url).href
);

function measure(updates, chunk) {
	const state = new ChildState();
	let text = "";
	let encodedBytes = 0;
	let scannedUnits = 0;
	const from = Buffer.from;
	const originals = new Map();
	Buffer.from = (value, ...args) => {
		if (typeof value === "string") encodedBytes += Buffer.byteLength(value);
		return Reflect.apply(from, Buffer, [value, ...args]);
	};
	for (const name of ["replace", "trim", "trimStart", "trimEnd", "search"]) {
		const original = String.prototype[name];
		originals.set(name, original);
		String.prototype[name] = function (...args) {
			scannedUnits += this.length;
			return Reflect.apply(original, this, args);
		};
	}
	try {
		for (let i = 0; i < updates; i++) {
			text += chunk;
			const partial = {
				role: "assistant",
				content: [{ type: "text", text }],
			};
			state.capture({
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: chunk,
					partial,
				},
			});
		}
	} finally {
		Buffer.from = from;
		for (const [name, original] of originals) String.prototype[name] = original;
		state.cleanup();
	}
	assert.ok(Buffer.byteLength(state.trail().join("")) <= 4096 + 32);
	return {
		updates,
		finalBytes: Buffer.byteLength(text),
		encodedBytes,
		scannedUnits,
	};
}

for (const [name, chunk] of [
	["text", "abcdefghij abcdefghij abcdefghij "],
	["whitespace", " \t\n".repeat(11)],
	["unicode", "😀 é 界 ".repeat(4)],
]) {
	let previous;
	for (const updates of [1000, 2000, 4000]) {
		const result = measure(updates, chunk);
		console.log(JSON.stringify({ workload: name, ...result }));
		if (!baseline && previous) {
			assert.ok(result.encodedBytes <= previous.encodedBytes * 2.3);
			assert.ok(result.scannedUnits <= previous.scannedUnits * 2.3);
		}
		previous = result;
	}
}
