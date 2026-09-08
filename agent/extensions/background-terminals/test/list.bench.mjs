// Run with node agent/extensions/background-terminals/test/list.bench.mjs.
// Optional module URL permits the same probe against a baseline checkout.
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { Effect } from "effect";
import { nodeCommand } from "./node-command.ts";

const { BackgroundTerminalManager, RETAINED_BYTES } = await import(
	process.argv[2] ?? "../manager.ts"
);
const manager = new BackgroundTerminalManager();
const original = Buffer.prototype.toString;
try {
	const run = manager.start({
		command: nodeCommand(
			`process.stdout.write("x".repeat(${RETAINED_BYTES})); setInterval(()=>{},1000)`,
		),
		title: "listing probe",
		cwd: process.cwd(),
	});
	const deadline = Date.now() + 5000;
	while (manager.get(run.id)?.stdout.totalBytes !== RETAINED_BYTES) {
		assert.ok(Date.now() < deadline, "terminal output readiness");
		await setTimeout(10);
	}
	let decodedBytes = 0;
	Buffer.prototype.toString = function (...args) {
		decodedBytes += this.length;
		return Reflect.apply(original, this, args);
	};
	for (let i = 0; i < 100; i++)
		assert.equal(
			manager.list().filter((entry) => entry.state === "running").length,
			1,
		);
	Buffer.prototype.toString = original;
	console.log(
		JSON.stringify({
			listings: 100,
			retainedBytes: RETAINED_BYTES,
			decodedBytes,
		}),
	);
} finally {
	Buffer.prototype.toString = original;
	await Effect.runPromise(manager.shutdown());
}
