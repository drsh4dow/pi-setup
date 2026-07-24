import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { processIsGone } from "../../test/process.ts";
import delegateExtension, {
  BackgroundDelivery,
  childExtensionPaths,
  extractAssistantText,
  formatDelegateOutput,
  readDelegateModelSetting,
  resolveDelegateModel,
  selectChildToolNames,
  thinkingForEffort,
} from "../index.ts";
import { createChild, shutdownChild } from "../runtime.ts";

type ResolveContext = Parameters<typeof resolveDelegateModel>[0];
type RegistryModel = NonNullable<ResolveContext["model"]>;

const parentModel = { provider: "anthropic", id: "parent" } as RegistryModel;
const configuredModel = { provider: "opencode", id: "fable" } as RegistryModel;
const settingsDir = mkdtempSync(join(tmpdir(), "pi-delegate-test-"));
let settingsNumber = 0;

test.after(() => rmSync(settingsDir, { recursive: true, force: true }));

function fakeContext(options?: {
  parent?: boolean;
  auth?: boolean;
}): ResolveContext {
  return {
    model: (options?.parent ?? true) ? parentModel : undefined,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "opencode" && id === "fable" ? configuredModel : undefined,
      hasConfiguredAuth: () => options?.auth ?? true,
    } as ResolveContext["modelRegistry"],
  };
}

function settingsFile(content: string): string {
  const path = join(settingsDir, `settings-${settingsNumber++}.json`);
  writeFileSync(path, content, "utf8");
  return path;
}

test("reads the delegate model from settings.json", () => {
  assert.deepEqual(
    readDelegateModelSetting(
      settingsFile('{"delegate": {"model": " opencode/fable "}}'),
    ),
    { model: "opencode/fable" },
  );
  assert.deepEqual(
    readDelegateModelSetting(settingsFile('{"theme": "dark"}')),
    {},
  );
  assert.deepEqual(
    readDelegateModelSetting(join(tmpdir(), "pi-delegate-test-missing.json")),
    {},
  );
});

test("reports malformed delegate settings as problems, not failures", () => {
  assert.match(
    readDelegateModelSetting(settingsDir).problem ?? "",
    /Could not read/,
  );
  assert.match(
    readDelegateModelSetting(settingsFile("{not json")).problem ?? "",
    /Could not parse/,
  );
  assert.match(
    readDelegateModelSetting(settingsFile('{"delegate": true}')).problem ?? "",
    /must be an object/,
  );
  assert.match(
    readDelegateModelSetting(settingsFile('{"delegate": {"model": 42}}'))
      .problem ?? "",
    /must be a "provider\/model-id" string/,
  );
});

test("uses the configured delegate model when available", () => {
  const choice = resolveDelegateModel(fakeContext(), {
    model: "opencode/fable",
  });
  assert.equal(choice.model, configuredModel);
  assert.equal(choice.requestedModel, "opencode/fable");
  assert.equal(choice.fallbackReason, undefined);
});

test("falls back to the parent model when the configured model is unusable", () => {
  const missing = resolveDelegateModel(fakeContext(), {
    model: "opencode/unknown",
  });
  assert.equal(missing.model, parentModel);
  assert.equal(missing.requestedModel, "opencode/unknown");
  assert.match(missing.fallbackReason ?? "", /not found in the model registry/);

  const unauthenticated = resolveDelegateModel(fakeContext({ auth: false }), {
    model: "opencode/fable",
  });
  assert.equal(unauthenticated.model, parentModel);
  assert.match(unauthenticated.fallbackReason ?? "", /no auth configured/);

  const malformed = resolveDelegateModel(fakeContext(), { model: "fable" });
  assert.equal(malformed.model, parentModel);
  assert.match(
    malformed.fallbackReason ?? "",
    /must be a "provider\/model-id" string/,
  );
});

test("defaults to the parent model without a configured delegate model", () => {
  assert.deepEqual(resolveDelegateModel(fakeContext(), {}), {
    model: parentModel,
    requestedModel: "parent model",
    fallbackReason: undefined,
  });

  const orphan = resolveDelegateModel(fakeContext({ parent: false }), {
    problem: "Could not parse settings.json.",
  });
  assert.equal(orphan.model, undefined);
  assert.equal(
    orphan.fallbackReason,
    "Could not parse settings.json. No parent model was available; Pi will use its normal session default.",
  );

  const parentFallback = resolveDelegateModel(fakeContext(), {
    problem: "Could not parse settings.json.",
  });
  assert.equal(
    parentFallback.fallbackReason,
    "Could not parse settings.json. Using the parent model instead.",
  );
});

test("registers blocking, control, and workflow tools", () => {
  const tools: Array<{
    name: string;
    executionMode?: "sequential" | "parallel";
    execute: unknown;
    renderCall?: unknown;
    renderResult?: unknown;
  }> = [];
  delegateExtension({
    on() {},
    registerTool(registered: ToolDefinition) {
      tools.push(registered);
    },
  } as unknown as ExtensionAPI);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["delegate", "delegate_control", "delegate_workflow"],
  );
  assert.ok(tools.every((tool) => tool.executionMode === "parallel"));
  assert.equal(typeof tools[0].execute, "function");
  assert.equal(typeof tools[0].renderCall, "function");
  assert.equal(typeof tools[0].renderResult, "function");
  const blockingProperties = (
    tools[0] as unknown as { parameters: { properties: object } }
  ).parameters.properties;
  const controlProperties = (
    tools[1] as unknown as { parameters: { properties: object } }
  ).parameters.properties;
  assert.ok("schema" in blockingProperties);
  assert.ok("schema" in controlProperties);
});

test("background delivery follows up once and retries failed sends", async () => {
  const messages: Array<{ message: unknown; options: unknown }> = [];
  let attempts = 0;
  let idle = true;
  const delivery = new BackgroundDelivery({
    sendMessage(message: unknown, options: unknown) {
      attempts++;
      if (attempts === 1) throw new Error("temporary send failure");
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI);
  delivery.setContext({ isIdle: () => idle } as ExtensionContext);
  const snapshot = {
    id: "delegate-1",
    status: "done",
    workspace: "read",
    output: "background result",
    resumable: true,
    success: true,
    assignedTask: "fixture",
    effort: "fast",
    requestedModel: "test/model",
    model: "test/model",
    thinking: "low",
    createdAt: 0,
    settledAt: 1,
    durationMs: 1,
    toolCalls: 0,
    failedToolCalls: 0,
    childUsage: {
      turns: 1,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: 0,
    },
    aborted: false,
  } as const;

  delivery.enqueue(snapshot);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(attempts, 1);
  assert.equal(messages.length, 0);

  await delivery.flush();
  assert.equal(attempts, 2);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
  assert.match(
    (messages[0].message as { content: string }).content,
    /background result/,
  );

  await delivery.flush();
  assert.equal(attempts, 2);

  idle = false;
  delivery.enqueue({ ...snapshot, id: "delegate-2" });
  delivery.consume(["delegate-2"]);
  await delivery.flush();
  assert.equal(attempts, 2);
});

test("maps effort to the child thinking level", () => {
  assert.equal(thinkingForEffort("fast"), "low");
  assert.equal(thinkingForEffort("thorough"), "high");
});

test("keeps child tools unique and allows owned background terminals", () => {
  assert.deepEqual(
    selectChildToolNames([
      { name: "read" },
      { name: "delegate" },
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
    createChild({ cwd: settingsDir } as ExtensionContext, undefined, "low"),
  );
  try {
    assert.match(
      child.systemPrompt,
      /^You are Pi running as a delegated child agent in a fresh context\./,
    );
    assert.match(
      child.systemPrompt,
      /The child role does not itself prohibit commits/,
    );
    assert.match(child.systemPrompt, /# Code economy/);
    assert.doesNotMatch(
      child.systemPrompt,
      /your job is to collaborate with them until their goal is genuinely handled/,
    );
    assert.doesNotMatch(child.systemPrompt, /Final report:/);
  } finally {
    child.dispose();
  }
});

test("child runs release owned background terminals before returning", async () => {
  const child = await Effect.runPromise(
    createChild({ cwd: settingsDir } as ExtensionContext, undefined, "low"),
  );
  try {
    assert.ok(child.getActiveToolNames().includes("bg_start"));
    const start = child.getToolDefinition("bg_start");
    assert.ok(start);
    const first = await start.execute(
      "call-1",
      { command: "sleep 30", title: "child terminal" },
      undefined,
      undefined,
      { cwd: settingsDir } as ExtensionContext,
    );
    const pid = (first.details as { pid: number }).pid;
    assert.ok(pid);
    const originalError = console.error;
    console.error = () => {};
    try {
      await child.extensionRunner.emit({ type: "agent_end", messages: [] });
    } finally {
      console.error = originalError;
    }
    assert.ok(processIsGone(pid));
    const second = await start.execute(
      "call-2",
      { command: "true", title: "next run" },
      undefined,
      undefined,
      { cwd: settingsDir } as ExtensionContext,
    );
    assert.ok((second.details as { pid?: number }).pid);
  } finally {
    await shutdownChild(child);
  }
});

test("initializes lifecycle-dependent web tools in child sessions", async () => {
  const originalPaths = process.env.PI_CHILD_EXTENSION_PATHS;
  process.env.PI_CHILD_EXTENSION_PATHS = fileURLToPath(
    new URL("../../web-access/index.ts", import.meta.url),
  );
  let child: AgentSession | undefined;
  try {
    child = await Effect.runPromise(
      createChild({ cwd: settingsDir } as ExtensionContext, undefined, "low"),
    );
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
      Effect.runPromise(
        createChild({ cwd: settingsDir } as ExtensionContext, undefined, "low"),
      ),
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
