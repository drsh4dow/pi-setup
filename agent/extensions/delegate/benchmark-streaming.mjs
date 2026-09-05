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

function measure(updates, chunk, multipart = false) {
	const state = new ChildState();
	let text = "";
	let encodedBytes = 0;
	let scannedUnits = 0;
	let contentReads = 0;
	const content = new Proxy([], {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) contentReads++;
			return Reflect.get(target, key, receiver);
		},
	});
	const partial = { role: "assistant", content };
	const emit = (event) =>
		state.capture({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { ...event, partial },
		});
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
		state.capture({ type: "message_start", message: partial });
		if (!multipart) {
			content.push({ type: "text", text: "" });
			emit({ type: "text_start", contentIndex: 0 });
		}
		for (let i = 0; i < updates; i++) {
			text += chunk;
			const contentIndex = multipart ? i : 0;
			if (multipart) {
				content.push({ type: "text", text: "" });
				emit({ type: "text_start", contentIndex });
			}
			content[contentIndex].text += chunk;
			emit({ type: "text_delta", contentIndex, delta: chunk });
			if (multipart) emit({ type: "text_end", contentIndex, content: chunk });
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
		contentReads,
		...retention(state.streaming),
	};
}

// Benchmark-only inspection: counts retained preview strings/objects, not SDK
// message storage. Behavioral tests use only ChildState's public event seam.
function retention(value) {
	let retainedUnits = 0;
	let retainedObjects = 0;
	function visit(item) {
		if (typeof item === "string") retainedUnits += item.length;
		else if (item && typeof item === "object") {
			retainedObjects++;
			for (const child of item instanceof Map
				? item.values()
				: Object.values(item))
				visit(child);
		}
	}
	visit(value);
	return { retainedUnits, retainedObjects };
}

for (const [name, chunk] of [
	["multipart", " small block 😀 "],
	["text", "abcdefghij abcdefghij abcdefghij "],
	["whitespace", " \t\n".repeat(11)],
	["unicode", "😀 é 界 ".repeat(4)],
]) {
	let previous;
	for (const updates of [1000, 2000, 4000]) {
		const result = measure(updates, chunk, name === "multipart");
		console.log(JSON.stringify({ workload: name, ...result }));
		if (!baseline && previous) {
			assert.ok(result.encodedBytes <= previous.encodedBytes * 2.6);
			assert.ok(result.scannedUnits <= previous.scannedUnits * 2.6);
			assert.ok(result.contentReads <= previous.contentReads * 2.3);
			if (name === "multipart") {
				assert.ok(result.retainedUnits <= 17000);
				assert.equal(result.retainedObjects, previous.retainedObjects);
			}
		}
		previous = result;
	}
}
