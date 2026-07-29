import assert from "node:assert/strict";

const { mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("fs");
const { readFile, unlink } = process.getBuiltinModule("fs/promises");

import { tmpdir } from "node:os";

const { delimiter, join } = process.getBuiltinModule("path");

import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	DEFAULT_MAX_LINES,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
	childExtensionPaths,
	extractAssistantText,
	formatDelegateOutput,
	resultText,
	selectChildToolNames,
	thinkingForEffort,
} from "../index.ts";
import { createChild, shutdownChild } from "../runtime.ts";
import { snapshot } from "./snapshot.ts";

const settingsDir = mkdtempSync(join(tmpdir(), "pi-delegate-test-"));

test.after(() => rmSync(settingsDir, { recursive: true, force: true }));

test("maps effort to the child thinking level", () => {
	assert.equal(thinkingForEffort("fast"), "low");
	assert.equal(thinkingForEffort("thorough"), "high");
});

test("keeps child tools unique and allows owned background terminals", () => {
	assert.deepEqual(
		selectChildToolNames([
			{ name: "read" },
			{ name: "delegate_run" },
			{ name: "delegate_session" },
			{ name: "read" },
			{ name: "bash" },
			{ name: "bg_start" },
			{ name: "bg_status" },
			{ name: "bg_list" },
			{ name: "bg_kill" },
			{ name: "subagent" },
		]),
		["read", "bash", "bg_start", "bg_status", "bg_list", "bg_kill"],
	);
});

test("normalizes configured child extension paths", () => {
	assert.deepEqual(
		childExtensionPaths({
			PI_CHILD_EXTENSION_PATHS: [" /one ", "", "/two", "/one"].join(delimiter),
		}),
		["/one", "/two"],
	);
});

test("uses the standalone delegated system prompt", async () => {
	const child = await Effect.runPromise(
		createChild(settingsDir, undefined, "low"),
	);
	try {
		assert.match(
			child.systemPrompt,
			/^You are Pi, running as a delegated child in a fresh context\./,
		);
		assert.match(child.systemPrompt, /The assignment is your briefing packet/);
		assert.match(
			child.systemPrompt,
			/Honor the mutation authority the assignment states/,
		);
		assert.match(child.systemPrompt, /# Code economy/);
		assert.match(
			child.systemPrompt,
			/one hard execution ceiling: 60 minutes of wall time or 60,000,000 reported tokens/,
		);
		assert.doesNotMatch(
			child.systemPrompt,
			/exhaust safe in-scope alternatives/,
		);
		assert.doesNotMatch(
			child.systemPrompt,
			/Do not stop because the run is long/,
		);
		assert.doesNotMatch(child.systemPrompt, /never to the effort you spend/);
		assert.doesNotMatch(
			child.systemPrompt,
			/your job is to collaborate with them until their goal is genuinely handled/,
		);
		assert.doesNotMatch(child.systemPrompt, /Final report:/);
	} finally {
		child.dispose();
	}
});

test("child sessions expose all parent-owned background terminal tools", async () => {
	const originalPaths = process.env.PI_CHILD_EXTENSION_PATHS;
	process.env.PI_CHILD_EXTENSION_PATHS = fileURLToPath(
		new URL("../../background-terminals/index.ts", import.meta.url),
	);
	let child: AgentSession | undefined;
	try {
		child = await Effect.runPromise(createChild(settingsDir, undefined, "low"));
		assert.deepEqual(
			child
				.getActiveToolNames()
				.filter((name) => name.startsWith("bg_"))
				.sort(),
			["bg_kill", "bg_list", "bg_start", "bg_status"],
		);
	} finally {
		if (child) await shutdownChild(child);
		if (originalPaths === undefined)
			delete process.env.PI_CHILD_EXTENSION_PATHS;
		else process.env.PI_CHILD_EXTENSION_PATHS = originalPaths;
	}
});

test("initializes lifecycle-dependent web tools in child sessions", async () => {
	const originalPaths = process.env.PI_CHILD_EXTENSION_PATHS;
	process.env.PI_CHILD_EXTENSION_PATHS = fileURLToPath(
		new URL("../../web-access/index.ts", import.meta.url),
	);
	let child: AgentSession | undefined;
	try {
		child = await Effect.runPromise(createChild(settingsDir, undefined, "low"));
		const retrieval = child.getToolDefinition("get_search_content");
		assert.ok(retrieval);
		const result = await retrieval.execute(
			"call-1",
			{ responseId: "missing-response" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text =
			result.content.find((item) => item.type === "text")?.text ?? "";
		assert.match(text, /Response not found: missing-response/);
		assert.doesNotMatch(text, /Session Response Archive is unavailable/);
	} finally {
		child?.dispose();
		if (originalPaths === undefined)
			delete process.env.PI_CHILD_EXTENSION_PATHS;
		else process.env.PI_CHILD_EXTENSION_PATHS = originalPaths;
	}
});

test("surfaces delegated child extension startup failures", async () => {
	const extension = join(settingsDir, "failing-lifecycle-extension.ts");
	writeFileSync(
		extension,
		`export default function (pi) {
  pi.on("session_start", () => { throw new Error("fixture startup failed"); });
}
`,
		"utf8",
	);

	const originalPaths = process.env.PI_CHILD_EXTENSION_PATHS;
	process.env.PI_CHILD_EXTENSION_PATHS = extension;
	try {
		await assert.rejects(
			Effect.runPromise(createChild(settingsDir, undefined, "low")),
			/Child extension .* failed during session_start: fixture startup failed/,
		);
	} finally {
		if (originalPaths === undefined)
			delete process.env.PI_CHILD_EXTENSION_PATHS;
		else process.env.PI_CHILD_EXTENSION_PATHS = originalPaths;
	}
});

test("extracts only assistant text blocks", () => {
	assert.equal(
		extractAssistantText({
			role: "assistant",
			content: [
				{ type: "text", text: " first " },
				{ type: "toolCall", name: "read" },
				{ type: "text", text: "second" },
			],
		}),
		"first\nsecond",
	);
	assert.equal(extractAssistantText({ role: "user", content: "ignored" }), "");
});

test("leaves output below the truncation limit unchanged", async () => {
	assert.deepEqual(await formatDelegateOutput("child report"), {
		text: "child report",
	});
});

test("saves the complete report when output is truncated", async () => {
	const report = Array.from(
		{ length: DEFAULT_MAX_LINES + 1 },
		(_, index) => `line ${index}`,
	).join("\n");
	const output = await formatDelegateOutput(report);

	assert.equal(output.truncation?.truncated, true);
	assert.ok(output.fullOutputFile);
	try {
		assert.equal(await readFile(output.fullOutputFile, "utf8"), report);
	} finally {
		await unlink(output.fullOutputFile);
	}
});

test("uses an existing complete output archive for a bounded result", async () => {
	const fullOutputFile = join(settingsDir, "complete-child-output.txt");
	writeFileSync(fullOutputFile, "complete report", "utf8");
	const preview = "x".repeat(60_000);
	const output = await formatDelegateOutput(preview, fullOutputFile);

	assert.equal(output.fullOutputFile, fullOutputFile);
	assert.match(output.text, /available until the parent session ends/);
	assert.equal(await readFile(fullOutputFile, "utf8"), "complete report");
});

test("preserves complete output when archival fails", async () => {
	const originalTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = join(settingsDir, "missing-output-directory");
	const report = `start\n${"x".repeat(60_000)}\nend`;
	try {
		const output = await formatDelegateOutput(report);
		assert.equal(output.fullOutputFile, undefined);
		assert.equal(output.truncation, undefined);
		assert.ok(output.text.startsWith(report));
		assert.match(output.text, /complete output is shown here/);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	}
});

test("a checkpoint replaces the result rather than repeating it", async () => {
	const spoken = "PLAN MARKER: measuring sixteen files in order.";
	const contained = await resultText([
		snapshot({
			status: "cancelled",
			error: "Delegation cancelled",
			output: spoken,
			checkpoint: `Assistant\n\n${spoken}\n\nTool: bash {"command":"wc -c CONTEXT.md"} · done`,
		}),
	]);
	assert.equal(contained.match(/PLAN MARKER/g)?.length, 1);
	assert.match(contained, /Checkpoint \(child's last activity\)/);

	const truncated = await resultText([
		snapshot({
			status: "error",
			error: "Delegation stopped at the hard execution ceiling",
			output: `${spoken} The tail of this answer outlived the checkpoint window.`,
			checkpoint: 'Tool: bash {"command":"wc -c CONTEXT.md"} · done',
		}),
	]);
	assert.match(truncated, /outlived the checkpoint window/);

	const settled = await resultText([
		snapshot({ status: "done", success: true, output: spoken }),
	]);
	assert.equal(settled.match(/PLAN MARKER/g)?.length, 1);
	assert.doesNotMatch(settled, /Checkpoint/);
});
