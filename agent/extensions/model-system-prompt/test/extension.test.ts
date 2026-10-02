import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = process.getBuiltinModule("fs");

const { join } = process.getBuiltinModule("path");

const POLICIES = ["DEFAULT POLICY", "GPT POLICY", "PROJECT POLICY"];

// Each prompt optionally switches model first, then names the policy the model must receive.
const scenarios = [
  {
    name: "a GPT session keeps the GPT prompt after switching to Claude",
    projectPrompt: false,
    prompts: [
      { switchTo: undefined, policy: "GPT POLICY" },
      { switchTo: "claude-test", policy: "GPT POLICY" },
    ],
  },
  {
    name: "a switch before the first prompt sets the session model",
    projectPrompt: false,
    prompts: [
      { switchTo: "claude-test", policy: "DEFAULT POLICY" },
      { switchTo: "gpt-test", policy: "DEFAULT POLICY" },
    ],
  },
  {
    name: "a trusted project prompt applies to GPT sessions",
    projectPrompt: true,
    prompts: [{ switchTo: undefined, policy: "PROJECT POLICY" }],
  },
];

for (const scenario of scenarios) {
  test(scenario.name, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pi-model-system-prompt-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const agentDir = join(directory, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "SYSTEM.md"), "DEFAULT POLICY");
    writeFileSync(join(agentDir, "GPT_SYSTEM.md"), "GPT POLICY");

    if (scenario.projectPrompt) {
      mkdirSync(join(directory, ".pi"));
      writeFileSync(join(directory, ".pi", "SYSTEM.md"), "PROJECT POLICY");
    }

    const settingsManager = SettingsManager.inMemory({
      defaultProjectTrust: "always",
      compaction: { enabled: false },
      retry: { enabled: false },
    });

    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      extensionFactories: [(pi) => extension(pi, agentDir)],
    });

    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const provider = fauxProvider({ models: [{ id: "gpt-test" }, { id: "claude-test" }] });

    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      model: provider.getModel("gpt-test"),
      thinkingLevel: "off",
    });

    t.after(() => session.dispose());
    await session.bindExtensions({
      mode: "print",
      onError: (error) => assert.fail(error.error),
    });
    session.modelRuntime.registerNativeProvider(provider.provider);

    for (const { switchTo, policy } of scenario.prompts) {
      const model = switchTo === undefined ? undefined : provider.getModel(switchTo);

      // oxlint-disable-next-line no-await-in-loop -- Each switch must land before its prompt.
      if (model) await session.setModel(model);

      provider.setResponses([
        (context) => {
          const prompt = getCurrentSystemPrompt(context.messages);

          for (const marker of POLICIES) assert.equal(prompt.includes(marker), marker === policy);

          return fauxAssistantMessage("Verified response");
        },
      ]);
      // oxlint-disable-next-line no-await-in-loop -- Drive the shared session one prompt at a time.
      await session.prompt("Inspect the artifact.");
      assert.equal(session.getLastAssistantText(), "Verified response");
    }
  });
}
