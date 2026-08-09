import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import {
	earlyoomKillSince,
	SACRIFICE_TAG,
	tagCommand,
	tagPid,
} from "../../../lib/sacrifice.ts";
import sacrificePreference from "../index.ts";

const { execFileSync, spawn } = process.getBuiltinModule("node:child_process");
const { readFileSync } = process.getBuiltinModule("node:fs");
const { tmpdir } = process.getBuiltinModule("node:os");

const linux = process.platform === "linux";
const fakeContext = (cwd: string) =>
	({
		cwd,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
	}) as never;

test("tagCommand marks the shell and its descendants", { skip: !linux }, () => {
	const output = execFileSync(
		"/bin/sh",
		["-c", tagCommand("cat /proc/self/oom_score_adj")],
		{ encoding: "utf8" },
	);
	assert.equal(output.trim(), "500");
});

test("tag statement produces no output or failure", { skip: !linux }, () => {
	const output = execFileSync("/bin/sh", ["-c", `${SACRIFICE_TAG}\necho ok`], {
		encoding: "utf8",
	});
	assert.equal(output, "ok\n");
});

test("tagPid raises a live process's score", { skip: !linux }, () => {
	const child = spawn("sleep", ["5"], { stdio: "ignore" });
	try {
		assert.ok(child.pid);
		tagPid(child.pid);
		assert.equal(
			readFileSync(`/proc/${child.pid}/oom_score_adj`, "utf8").trim(),
			"500",
		);
	} finally {
		child.kill("SIGKILL");
	}
});

test("earlyoomKillSince never throws", () => {
	assert.equal(
		typeof earlyoomKillSince(Effect.runSync(Clock.currentTimeMillis)),
		"boolean",
	);
});

function registeredBash(): ToolDefinition {
	let captured: ToolDefinition | undefined;
	sacrificePreference({
		registerTool: (tool: ToolDefinition) => {
			captured = tool;
		},
	} as unknown as ExtensionAPI);
	assert.ok(captured, "extension registered no tool");
	assert.equal(captured.name, "bash");
	return captured;
}

test("override runs tagged commands transparently", { skip: !linux }, () => {
	const tool = registeredBash();
	return tool
		.execute(
			"t1",
			{ command: "cat /proc/self/oom_score_adj" },
			undefined,
			undefined,
			fakeContext(tmpdir()),
		)
		.then((result) => {
			const text = result.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
			assert.equal(text.trim(), "500");
		});
});

test("override passes ordinary failures through unchanged", {
	skip: !linux,
}, () => {
	const tool = registeredBash();
	return assert.rejects(
		tool.execute(
			"t2",
			{ command: "exit 7" },
			undefined,
			undefined,
			fakeContext(tmpdir()),
		),
		(error: Error) =>
			/Command exited with code 7/.test(error.message) &&
			!/earlyoom/.test(error.message),
	);
});
