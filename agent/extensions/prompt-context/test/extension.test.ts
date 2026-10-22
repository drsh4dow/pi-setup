import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
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

type CodemodeMode = "on" | "only";

type Fixture = Awaited<ReturnType<typeof startSession>>;

type Observed = {
  prompt: string;
  sections: NonNullable<NonNullable<ReturnType<typeof getCurrentSystemMessage>>["sections"]>;
  tools: string[];
};

async function startSession(
  t: TestContext,
  { custom, codemode }: { custom: boolean; codemode: CodemodeMode },
) {
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
    codemode: { mode: codemode },
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const mcp = { summary: "INITIAL MCP SUMMARY" };

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
          ["bash", "Run a command", ["Quote arguments"]],
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
          options.promptGuidelines.push("GLOBAL TOOL POLICY", "Be concise in your responses");
        });
      },
      extension,
      (pi) => {
        // Native MCP contributes this section after file extensions run.
        pi.on("before_agent_start", ({ systemPromptOptions: options }) => {
          options.sections.mcp_servers = mcp.summary;
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

  return { directory, mcp, provider, session };
}

async function observePrompt(fixture: Fixture, tools: readonly string[]): Promise<Observed> {
  let observed: Observed | undefined;

  fixture.session.setActiveToolsByName([...tools]);
  fixture.provider.setResponses([
    (context) => {
      const sections = getCurrentSystemMessage(context.messages)?.sections;
      assert.ok(sections, "prompt must remain structured");
      observed = {
        prompt: getCurrentSystemPrompt(context.messages),
        sections: { ...sections },
        tools: getCurrentTools(context.messages).map((tool) => tool.name),
      };

      return fauxAssistantMessage("Verified response");
    },
  ]);
  await fixture.session.prompt("Inspect the artifact.");
  assert.equal(fixture.session.getLastAssistantText(), "Verified response");
  assert.ok(observed, "provider must receive the request");

  return observed;
}

function countOf(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

test("custom prompt renders the stock tools and rules sections as tools change", async (t) => {
  const custom = await startSession(t, { custom: true, codemode: "on" });
  const stock = await startSession(t, { custom: false, codemode: "on" });

  for (const [index, tools] of [
    ["probe_write", "read", "bash", "no_snippet", "codemode"],
    ["probe_write", "read", "bash", "no_snippet", "codemode"],
    ["read"],
    ["bash"],
    [],
  ].entries()) {
    const summary = `MCP SUMMARY ${index}`;
    custom.mcp.summary = summary;
    stock.mcp.summary = summary;

    // oxlint-disable-next-line no-await-in-loop -- Each step observes the prompt after the previous run.
    const [customRun, stockRun] = await Promise.all([
      observePrompt(custom, tools),
      observePrompt(stock, tools),
    ]);

    assert.equal(customRun.sections.tools, stockRun.sections.tools, `tools for ${tools.join()}`);
    assert.equal(customRun.sections.rules, stockRun.sections.rules, `rules for ${tools.join()}`);
    assert.ok(customRun.sections.preamble?.includes("CUSTOM POLICY"));
    assert.equal(customRun.sections.active_tool_context, undefined);

    for (const [run, fixture] of [
      [customRun, custom],
      [stockRun, stock],
    ] as const) {
      assert.deepEqual(run.tools.toSorted(), tools.toSorted());

      for (const marker of [
        "<tools>",
        "<rules>",
        "PROJECT CONTEXT POLICY",
        "APPENDED POLICY",
        "EARLIER EXTENSION POLICY",
        "GLOBAL TOOL POLICY",
        "Be concise in your responses",
        summary,
      ]) {
        assert.equal(countOf(run.prompt, marker), 1, marker);
      }

      for (const [marker, expected] of [
        ["- probe_write: Write an artifact", tools.includes("probe_write")],
        ["- read: Read an artifact", tools.includes("read")],
        ["- bash: Run a command", tools.includes("bash")],
        ["(none)", !tools.some((name) => ["probe_write", "read", "bash"].includes(name))],
        ["Use bash for file operations", tools.includes("bash")],
        ["Write safely", tools.includes("probe_write")],
        ["Keep edits focused", tools.includes("read")],
        ["Inspect evidence", tools.includes("read")],
        ["Unlisted tool guidance", tools.includes("no_snippet")],
        ["no_snippet:", false],
        ["Use codemode to batch", tools.includes("codemode")],
        ["SAMPLE SKILL DESCRIPTION", tools.includes("read") || tools.includes("bash")],
        ["MCP SUMMARY 0", index === 0],
      ] as const) {
        assert.equal(countOf(run.prompt, marker), expected ? 1 : 0, marker);
      }

      assert.ok(run.prompt.includes(fixture.directory));
    }
  }
});

test("custom prompt leaves hidden tools out of the tools and rules sections", async (t) => {
  const custom = await startSession(t, { custom: true, codemode: "only" });
  const stock = await startSession(t, { custom: false, codemode: "only" });
  const tools = ["probe_write", "read", "codemode"];

  const [customRun, stockRun] = await Promise.all([
    observePrompt(custom, tools),
    observePrompt(stock, tools),
  ]);

  assert.deepEqual(customRun.tools, ["codemode"]);
  assert.equal(customRun.sections.tools, stockRun.sections.tools);
  assert.equal(customRun.sections.rules, stockRun.sections.rules);
  assert.ok(customRun.sections.tools?.includes("- codemode:"));

  for (const hidden of ["- read: Read an artifact", "Write safely", "Inspect evidence"]) {
    assert.equal(countOf(customRun.prompt, hidden), 0, hidden);
  }
});

test("codemode reaches tools under a custom prompt", async (t) => {
  const { provider, session } = await startSession(t, { custom: true, codemode: "on" });

  session.setActiveToolsByName(["read", "codemode"]);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: "text(await tools.read({}));" })),
    (context) => {
      const result = context.messages.at(-1);

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
