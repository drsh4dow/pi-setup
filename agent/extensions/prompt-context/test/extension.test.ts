import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import extension from "../index.ts";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } =
	process.getBuiltinModule("fs");
const { join } = process.getBuiltinModule("path");

for (const custom of [true, false]) {
	test(`${custom ? "custom" : "stock"} runtime prompt preserves loaded context and tracks tools across prompts`, (t) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const directory = mkdtempSync(join(tmpdir(), "pi-prompt-context-"));
				t.after(() => rmSync(directory, { recursive: true, force: true }));
				const agentDir = join(directory, "agent");
				mkdirSync(join(agentDir, "skills", "sample"), { recursive: true });
				writeFileSync(join(agentDir, "AGENTS.md"), "PROJECT CONTEXT POLICY");
				writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "APPENDED POLICY");
				writeFileSync(
					join(agentDir, "skills", "sample", "SKILL.md"),
					"---\nname: sample\ndescription: SAMPLE SKILL DESCRIPTION\n---\nInspect the sample.\n",
				);
				if (custom) writeFileSync(join(agentDir, "SYSTEM.md"), "CUSTOM POLICY");
				const settingsManager = SettingsManager.inMemory({
					defaultProjectTrust: "always",
					compaction: { enabled: false },
					retry: { enabled: false },
				});
				let priorPrompt = "";
				const loader = new DefaultResourceLoader({
					cwd: directory,
					agentDir,
					settingsManager,
					extensionFactories: [
						(pi) => {
							for (const [name, snippet, guidelines] of [
								[
									"probe_write",
									"Write an artifact",
									[" Keep edits focused ", "", "Keep edits focused"],
								],
								[
									"read",
									"Read an artifact",
									["Keep edits focused", "Inspect evidence"],
								],
								["no_snippet", undefined, []],
							] as const) {
								pi.registerTool({
									name,
									label: name,
									description: name,
									promptSnippet: snippet,
									promptGuidelines: [...guidelines],
									parameters: Type.Object({}),
									execute: () =>
										Promise.resolve({
											content: [{ type: "text", text: "ok" }],
											details: {},
										}),
								});
							}
							pi.on("before_agent_start", (event) => {
								priorPrompt = `${event.systemPrompt}\n\nEARLIER EXTENSION POLICY`;
								return { systemPrompt: priorPrompt };
							});
						},
						extension,
					],
				});
				yield* Effect.promise(() => loader.reload());
				assert.deepEqual(loader.getExtensions().errors, []);
				const provider = fauxProvider();
				const { session } = yield* Effect.acquireRelease(
					Effect.promise(() =>
						createAgentSession({
							cwd: directory,
							agentDir,
							resourceLoader: loader,
							settingsManager,
							sessionManager: SessionManager.inMemory(directory),
							model: provider.getModel(),
							thinkingLevel: "off",
						}),
					),
					({ session }) => Effect.sync(() => session.dispose()),
				);
				yield* Effect.promise(() =>
					session.bindExtensions({
						mode: "print",
						onError: (error) => assert.fail(error.error),
					}),
				);
				session.modelRuntime.registerNativeProvider(provider.provider);
				const bothTools =
					"\n\n## Active tools\n\n- probe_write: Write an artifact\n- read: Read an artifact\n\n## Tool guidelines\n\n- Keep edits focused\n- Inspect evidence";
				const readOnly =
					"\n\n## Active tools\n\n- read: Read an artifact\n\n## Tool guidelines\n\n- Keep edits focused\n- Inspect evidence";
				for (const [tools, suffix] of [
					[["probe_write", "read", "no_snippet"], bothTools],
					[["probe_write", "read", "no_snippet"], bothTools],
					[["read"], readOnly],
					[[], ""],
				] as const) {
					session.setActiveToolsByName([...tools]);
					let actual = "";
					provider.setResponses([
						(context) => {
							actual = context.systemPrompt ?? "";
							return fauxAssistantMessage("Verified response");
						},
					]);
					yield* Effect.promise(() => session.prompt("Inspect the artifact."));
					assert.equal(session.getLastAssistantText(), "Verified response");
					assert.equal(actual, priorPrompt + (custom ? suffix : ""));
					for (const marker of [
						"PROJECT CONTEXT POLICY",
						"APPENDED POLICY",
						"EARLIER EXTENSION POLICY",
					]) {
						assert.equal(actual.split(marker).length - 1, 1, marker);
					}
					assert.equal(
						actual.split("SAMPLE SKILL DESCRIPTION").length - 1,
						tools.length > 0 ? 1 : 0,
					);
					assert.match(actual, /Current working directory:/);
				}
			}).pipe(Effect.scoped),
		));
}
