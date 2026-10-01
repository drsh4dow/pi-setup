import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("fs");

const { join } = process.getBuiltinModule("path");

for (const custom of [true, false]) {
  test(`${custom ? "custom" : "stock"} prompt preserves sections, tracks tools, and supports codemode`, async (t) => {
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
      codemode: { mode: "on" },
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    let serverSummary = "INITIAL MCP SUMMARY";

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
              [" Keep edits focused ", "", "Keep edits focused", "Write safely"],
            ],
            ["read", "Read an artifact", ["Keep edits focused", "Inspect evidence"]],
            ["no_snippet", undefined, ["Unlisted tool guidance"]],
          ] as const) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              promptSnippet: snippet,
              promptGuidelines: [...guidelines],
              parameters: Type.Object({}),
              execute: async () => ({
                content: [{ type: "text", text: "artifact contents" }],
                details: {},
              }),
            });
          }

          pi.on("before_agent_start", ({ systemPromptOptions: options }) => {
            options.sections.earlier_policy = "EARLIER EXTENSION POLICY";
            options.promptGuidelines.push("GLOBAL TOOL POLICY");
          });
        },
        extension,
        (pi) => {
          // Native MCP contributes this section after file extensions run.
          pi.on("before_agent_start", ({ systemPromptOptions: options }) => {
            options.sections.mcp_servers = serverSummary;
          });
        },
        createCodemodeExtension(),
      ],
    });

    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const provider = fauxProvider();

    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      model: provider.getModel(),
      thinkingLevel: "off",
    });

    t.after(() => session.dispose());
    await session.bindExtensions({
      mode: "print",
      onError: (error) => assert.fail(error.error),
    });
    session.modelRuntime.registerNativeProvider(provider.provider);

    for (const tools of [
      ["probe_write", "read", "no_snippet", "codemode"],
      ["probe_write", "read", "no_snippet", "codemode"],
      ["read"],
      [],
    ]) {
      session.setActiveToolsByName(tools);
      provider.setResponses([
        (context) => {
          const prompt = getCurrentSystemPrompt(context.messages);
          const sections = getCurrentSystemMessage(context.messages)?.sections;
          assert.ok(sections, "prompt must remain structured");
          assert.equal(Boolean(sections.active_tool_context), custom);
          assert.deepEqual(
            getCurrentTools(context.messages)
              .map((tool) => tool.name)
              .toSorted(),
            tools.toSorted(),
          );

          for (const marker of [
            "PROJECT CONTEXT POLICY",
            "APPENDED POLICY",
            "EARLIER EXTENSION POLICY",
            "GLOBAL TOOL POLICY",
            serverSummary,
          ]) {
            assert.equal(prompt.split(marker).length - 1, 1, marker);
          }

          for (const [marker, expected] of [
            ["- probe_write: Write an artifact", tools.includes("probe_write")],
            ["- read: Read an artifact", tools.includes("read")],
            ["Write safely", tools.includes("probe_write")],
            ["Keep edits focused", tools.includes("read")],
            ["Inspect evidence", tools.includes("read")],
            ["Unlisted tool guidance", tools.includes("no_snippet")],
            ["Use codemode to batch", tools.includes("codemode")],
            ["SAMPLE SKILL DESCRIPTION", tools.includes("read")],
          ] as const) {
            assert.equal(prompt.split(marker).length - 1, expected ? 1 : 0, marker);
          }

          assert.ok(prompt.includes(directory));

          if (serverSummary !== "INITIAL MCP SUMMARY")
            assert.ok(!prompt.includes("INITIAL MCP SUMMARY"));

          return fauxAssistantMessage("Verified response");
        },
      ]);
      // oxlint-disable-next-line no-await-in-loop -- Drive the shared fixture and observe each result before the next step.
      await session.prompt("Inspect the artifact.");
      assert.equal(session.getLastAssistantText(), "Verified response");
      serverSummary = "UPDATED MCP SUMMARY";
    }

    session.setActiveToolsByName(["read", "codemode"]);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.read({}));" })),
      (context) => {
        const result = context.messages.at(-1);
        assert.equal(result?.role, "toolResult");

        if (result?.role !== "toolResult") assert.fail("Missing tool result");
        assert.equal(result.toolName, "codemode");
        assert.equal(result.isError, false);
        assert.ok(
          result.content.some(
            (part) => part.type === "text" && part.text.includes("artifact contents"),
          ),
        );

        return fauxAssistantMessage("Codemode verified");
      },
    ]);
    await session.prompt("Read the artifact through codemode.");
    assert.equal(session.getLastAssistantText(), "Codemode verified");
  });
}
