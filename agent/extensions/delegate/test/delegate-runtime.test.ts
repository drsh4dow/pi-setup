import assert from "node:assert/strict";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } =
	process.getBuiltinModule("fs");
const { readFile, unlink } = process.getBuiltinModule("fs/promises");

import { tmpdir } from "node:os";

const { delimiter, join } = process.getBuiltinModule("path");

import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { ConfigProvider, Effect } from "effect";
import {
	childExtensionPaths,
	formatDelegateOutput,
	resultText,
	selectChildToolNames,
	thinkingForEffort,
} from "../index.ts";
import { extractMessageText } from "../output.ts";
import { createChild, shutdownChild } from "../runtime.ts";
import { snapshot } from "./snapshot.ts";

const settingsDir = mkdtempSync(join(tmpdir(), "pi-delegate-test-"));
const agentDir = join(settingsDir, "agent");
mkdirSync(agentDir);
writeFileSync(
	join(agentDir, "APPEND_SYSTEM.md"),
	"GLOBAL SHARED POLICY",
	"utf8",
);
writeFileSync(
	join(agentDir, "settings.json"),
	'{"defaultProjectTrust":"always"}',
	"utf8",
);

const childConfig = (extensionPath = "") =>
	ConfigProvider.fromUnknown({ PI_CHILD_EXTENSION_PATHS: extensionPath });

test.after(() => rmSync(settingsDir, { recursive: true, force: true }));

test("covers delegated runtime helpers", () => {
	assert.equal(thinkingForEffort("fast"), "low");
	assert.equal(thinkingForEffort("thorough"), "high");

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

	assert.deepEqual(
		childExtensionPaths({
			PI_CHILD_EXTENSION_PATHS: [" /one ", "", "/two", "/one"].join(delimiter),
		}),
		["/one", "/two"],
	);

	assert.equal(
		extractMessageText({
			role: "assistant",
			content: [
				{ type: "text", text: " first " },
				{ type: "toolCall", name: "read" },
				{ type: "text", text: "second" },
			],
		}),
		"first\nsecond",
	);
	assert.equal(extractMessageText({ content: " user text " }), "user text");
	assert.equal(extractMessageText(null), "");
	assert.equal(
		extractMessageText({ content: [{ type: "text", text: 42 }] }),
		"",
	);
});

test("covers delegated runtime behavior", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const promptChild = yield* createChild(
				settingsDir,
				undefined,
				"low",
				agentDir,
			).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					childConfig(
						fileURLToPath(
							new URL("../../process-status/index.ts", import.meta.url),
						),
					),
				),
			);
			const policy = "GLOBAL SHARED POLICY";
			assert.equal(promptChild.systemPrompt.split(policy).length - 1, 1);
			assert.match(promptChild.systemPrompt, /Available tools:/);
			assert.match(
				promptChild.systemPrompt,
				/You are handling one delegated task/,
			);
			assert.match(
				promptChild.systemPrompt,
				/Finish when the assignment is satisfied/,
			);
			assert.ok(promptChild.getActiveToolNames().includes("session_usage"));
			promptChild.dispose();

			const projectDir = join(settingsDir, "custom-prompt-project");
			mkdirSync(join(projectDir, ".pi"), { recursive: true });
			writeFileSync(
				join(projectDir, ".pi", "DELEGATE_SYSTEM.md"),
				"PROJECT DELEGATE PROMPT",
				"utf8",
			);
			writeFileSync(
				join(projectDir, ".pi", "APPEND_SYSTEM.md"),
				"PROJECT SHARED POLICY",
				"utf8",
			);
			const customizedChild = yield* createChild(
				projectDir,
				undefined,
				"low",
				agentDir,
			).pipe(
				Effect.provideService(ConfigProvider.ConfigProvider, childConfig()),
			);
			assert.match(customizedChild.systemPrompt, /PROJECT DELEGATE PROMPT/);
			assert.equal(
				customizedChild.systemPrompt.split("PROJECT SHARED POLICY").length - 1,
				1,
			);
			assert.match(
				customizedChild.systemPrompt,
				/You are handling one delegated task/,
			);
			assert.ok(!customizedChild.systemPrompt.includes(policy));
			customizedChild.dispose();

			const backgroundExtension = fileURLToPath(
				new URL("../../background-terminals/index.ts", import.meta.url),
			);
			const backgroundChild = yield* createChild(
				settingsDir,
				undefined,
				"low",
				agentDir,
			).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					childConfig(backgroundExtension),
				),
			);
			assert.deepEqual(
				backgroundChild
					.getActiveToolNames()
					.filter((name) => name.startsWith("bg_"))
					.sort(),
				["bg_kill", "bg_list", "bg_start", "bg_status"],
			);
			yield* shutdownChild(backgroundChild);

			const failingExtension = join(
				settingsDir,
				"failing-lifecycle-extension.ts",
			);
			writeFileSync(
				failingExtension,
				`export default function (pi) {
  pi.on("session_start", () => { throw new Error("fixture startup failed"); });
}
`,
				"utf8",
			);
			const failure = yield* createChild(
				settingsDir,
				undefined,
				"low",
				agentDir,
			).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					childConfig(failingExtension),
				),
				Effect.flip,
			);
			assert.match(
				failure.message,
				/Child extension .* failed during session_start: fixture startup failed/,
			);

			assert.deepEqual(yield* formatDelegateOutput("child report"), {
				text: "child report",
			});

			const lineReport = Array.from(
				{ length: DEFAULT_MAX_LINES + 1 },
				(_, index) => `line ${index}`,
			).join("\n");
			const truncatedOutput = yield* formatDelegateOutput(lineReport);
			assert.equal(truncatedOutput.truncation?.truncated, true);
			assert.ok(truncatedOutput.fullOutputFile);
			assert.equal(
				yield* Effect.promise(() =>
					readFile(truncatedOutput.fullOutputFile, "utf8"),
				),
				lineReport,
			);
			yield* Effect.promise(() => unlink(truncatedOutput.fullOutputFile));

			const fullOutputFile = join(settingsDir, "complete-child-output.txt");
			writeFileSync(fullOutputFile, "complete report", "utf8");
			const archivedOutput = yield* formatDelegateOutput(
				"x".repeat(60_000),
				fullOutputFile,
			);
			assert.equal(archivedOutput.fullOutputFile, fullOutputFile);
			assert.match(
				archivedOutput.text,
				/available until the parent session ends/,
			);
			assert.equal(
				yield* Effect.promise(() => readFile(fullOutputFile, "utf8")),
				"complete report",
			);

			const failedReport = `start\n${"x".repeat(60_000)}\nend`;
			const failedArchiveOutput = yield* formatDelegateOutput(
				failedReport,
			).pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({
						TMPDIR: join(settingsDir, "missing-output-directory"),
					}),
				),
			);
			assert.equal(failedArchiveOutput.fullOutputFile, undefined);
			assert.equal(failedArchiveOutput.truncation, undefined);
			assert.ok(failedArchiveOutput.text.startsWith(failedReport));
			assert.match(failedArchiveOutput.text, /complete output is shown here/);

			const spoken = "PLAN MARKER: measuring sixteen files in order.";
			const contained = yield* resultText([
				snapshot({
					status: "cancelled",
					error: "Delegation cancelled",
					output: spoken,
					checkpoint: `Assistant\n\n${spoken}\n\nTool: bash {"command":"wc -c CONTEXT.md"} · done`,
				}),
			]);
			assert.equal(contained.match(/PLAN MARKER/g)?.length, 1);
			assert.match(contained, /Checkpoint \(child's last activity\)/);
			const truncated = yield* resultText([
				snapshot({
					status: "error",
					error: "Delegation stopped at the hard execution ceiling",
					output: `${spoken} The tail of this answer outlived the checkpoint window.`,
					checkpoint: 'Tool: bash {"command":"wc -c CONTEXT.md"} · done',
				}),
			]);
			assert.match(truncated, /outlived the checkpoint window/);
			const settled = yield* resultText([
				snapshot({ status: "done", success: true, output: spoken }),
			]);
			assert.equal(settled.match(/PLAN MARKER/g)?.length, 1);
			assert.doesNotMatch(settled, /Checkpoint/);
		}),
	));
