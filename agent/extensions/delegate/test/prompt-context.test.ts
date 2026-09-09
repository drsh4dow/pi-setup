import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ConfigProvider, Effect } from "effect";
import { createChild, shutdownChild } from "../runtime.ts";

const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } =
	process.getBuiltinModule("fs");
const { join } = process.getBuiltinModule("path");

for (const projectOverride of [false, true]) {
	test(`child discovers prompt context with ${projectOverride ? "project" : "global"} custom instructions`, (t) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const directory = mkdtempSync(
					join(tmpdir(), "pi-child-prompt-context-"),
				);
				t.after(() => rmSync(directory, { recursive: true, force: true }));
				const agentDir = join(directory, "agent");
				const extensions = join(agentDir, "extensions");
				mkdirSync(extensions, { recursive: true });
				writeFileSync(
					join(agentDir, "settings.json"),
					'{"defaultProjectTrust":"always"}',
				);
				writeFileSync(
					join(agentDir, "SYSTEM.md"),
					"GLOBAL CUSTOM INSTRUCTIONS",
				);
				writeFileSync(
					join(agentDir, "APPEND_SYSTEM.md"),
					"SHARED APPEND POLICY",
				);
				if (projectOverride) {
					mkdirSync(join(directory, ".pi"));
					writeFileSync(
						join(directory, ".pi", "DELEGATE_SYSTEM.md"),
						"PROJECT CHILD INSTRUCTIONS",
					);
				}
				symlinkSync(
					fileURLToPath(new URL("../../prompt-context", import.meta.url)),
					join(extensions, "prompt-context"),
					"dir",
				);
				writeFileSync(
					join(extensions, "fixture.ts"),
					`
export default function (pi) {
  for (const [name, snippet, guideline] of [
    ["probe_action", "Inspect a child artifact", "Check the child artifact before returning."],
    ["delegate_run", "Spawn another child", "Parent owns integration and verification."],
  ]) {
    pi.registerTool({
      name, label: name, description: snippet, promptSnippet: snippet,
      promptGuidelines: [guideline], parameters: { type: "object", properties: {} },
      execute: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  }
}
`,
				);
				const provider = fauxProvider();
				const child = yield* Effect.acquireRelease(
					createChild(directory, provider.getModel(), "off", agentDir).pipe(
						Effect.provideService(
							ConfigProvider.ConfigProvider,
							ConfigProvider.fromUnknown({ PI_CHILD_EXTENSION_PATHS: "" }),
						),
					),
					shutdownChild,
				);
				child.modelRuntime.registerNativeProvider(provider.provider);
				let effectivePrompt = "";
				provider.setResponses([
					(context) => {
						effectivePrompt = context.systemPrompt ?? "";
						return fauxAssistantMessage("Child response");
					},
				]);
				yield* Effect.promise(() =>
					child.prompt("Inspect the assigned artifact."),
				);
				assert.match(
					effectivePrompt,
					/- probe_action: Inspect a child artifact/,
				);
				assert.match(
					effectivePrompt,
					/- Check the child artifact before returning\./,
				);
				assert.doesNotMatch(
					effectivePrompt,
					/Spawn another child|Parent owns integration and verification\./,
				);
				assert.equal(
					effectivePrompt.split("SHARED APPEND POLICY").length - 1,
					1,
				);
				assert.match(effectivePrompt, /You are handling one delegated task/);
				assert.match(
					effectivePrompt,
					projectOverride
						? /PROJECT CHILD INSTRUCTIONS/
						: /GLOBAL CUSTOM INSTRUCTIONS/,
				);
				assert.equal(child.getLastAssistantText(), "Child response");
			}).pipe(Effect.scoped),
		));
}
