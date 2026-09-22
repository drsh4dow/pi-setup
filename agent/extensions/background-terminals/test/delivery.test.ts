import assert from "node:assert/strict";
import test from "node:test";
import {
	BackgroundTerminalDelivery,
	formatTerminalReport,
} from "../delivery.ts";
import { MAX_TRACKED } from "../manager.ts";
import { type SettledTerminalSnapshot, Tail } from "../terminal.ts";
import {
	type DeliveryMessage,
	decodeMessage,
	testContext,
} from "./registration.ts";

function snapshot(stdout: string, stderr = ""): SettledTerminalSnapshot {
	const out = new Tail();
	const err = new Tail();
	out.append(Buffer.from(stdout));
	err.append(Buffer.from(stderr));

	return {
		id: "bt-1",
		title: "repository scout",
		command: "pi --print <<'PROMPT'\nRead the repository.\nPROMPT",
		cwd: "/project",
		state: "done",
		createdAt: 0,
		settledAt: 1_000,
		result: { kind: "success" },
		stdout: out.view(),
		stderr: err.view(),
	};
}

function completion(terminal: SettledTerminalSnapshot): string {
	const messages: string[] = [];

	const delivery = new BackgroundTerminalDelivery({
		sendMessage(message) {
			messages.push(decodeMessage(message).content);
		},
	});

	try {
		delivery.setContext(testContext({ isIdle: () => false }));
		delivery.enqueue(terminal);
		assert.equal(messages.length, 1);

		return messages[0];
	} finally {
		delivery.clear();
	}
}

test("splits queued completions into bounded batches without losing results", () => {
	const messages: DeliveryMessage[] = [];

	const terminal: SettledTerminalSnapshot = {
		...snapshot("é".repeat(20_000), "é".repeat(20_000)),
		id: "bt-0",
		title: "x".repeat(80),
		cwd: `/${"w".repeat(4_094)}`,
		state: "failed",
		result: {
			kind: "error",
			error: "e".repeat(4_096),
			exit: { kind: "unknown" },
		},
	};

	const delivery = new BackgroundTerminalDelivery({
		sendMessage(message) {
			messages.push(decodeMessage(message));

			// Completions arriving during delivery must wait for the next batch.
			if (messages.length === 1)
				for (let index = 1; index < MAX_TRACKED; index++)
					delivery.enqueue({ ...terminal, id: `bt-${index}` });
		},
	});

	try {
		delivery.setContext(testContext({ isIdle: () => false }));
		delivery.enqueue(terminal);
		const batches = messages.slice(1);
		assert.ok(batches.length > 1, "queued results must span multiple batches");
		assert.ok(batches.some((message) => message.details.ids.length > 1));
		assert.ok(
			messages.every(
				(message) => Buffer.byteLength(message.content) <= 256 * 1024,
			),
		);
		assert.deepEqual(
			messages.flatMap((message) => message.details.ids),
			Array.from({ length: MAX_TRACKED }, (_, index) => `bt-${index}`),
		);
		assert.ok(messages.every((message) => !message.content.includes("�")));
	} finally {
		delivery.clear();
	}
});

test("completion preserves a report beyond the old byte and line limits without repeating the command", () => {
	const report = Array.from(
		{ length: 120 },
		(_, index) =>
			`Finding ${index}: representative source evidence for the scout.`,
	).join("\n");

	const terminal = snapshot(report);
	const message = completion(terminal);

	assert.ok(message.includes(report));
	assert.match(message, /bt-1 \[done\] repository scout · exit 0 · 1s/);
	assert.doesNotMatch(message, /command:|cwd:|abbreviated|discarded/);

	const details = formatTerminalReport(terminal);
	assert.match(details, /command: pi --print/);
	assert.match(details, /cwd: \/project/);
});

test("completion distinguishes display abbreviation from retention loss and shares its output budget", () => {
	const terminal = snapshot("é".repeat(140_000), "warning\n".repeat(3_000));
	const message = completion(terminal);

	assert.match(
		message,
		/stdout \(17856 earlier bytes discarded by retention\)/,
	);
	assert.match(
		message,
		/stdout display abbreviated: \d+ retained bytes not shown/,
	);
	assert.match(
		message,
		/stderr display abbreviated: \d+ retained bytes not shown/,
	);
	assert.match(message, /Use bg_status bt-1 for more retained output/);
	assert.doesNotMatch(message, /�/);

	const stdout = message
		.split("\nstdout (17856 earlier bytes discarded by retention):\n")[1]
		.split("\nstdout display abbreviated:")[0];

	const stderr = message
		.split("\nstderr:\n")[1]
		.split("\nstderr display abbreviated:")[0];

	assert.equal(
		Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
		24 * 1024,
	);

	const details = formatTerminalReport(terminal);
	assert.ok(details.length > message.length);
	assert.match(details, /17856 earlier bytes discarded by retention/);
	assert.match(details, /stdout display abbreviated:/);
});
