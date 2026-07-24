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
import { processStatusView } from "../../process-status/status.ts";
import { processIsGone } from "../../test/process.ts";
import type { DelegateSnapshot } from "../contract.ts";
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
import { eventually } from "./eventually.ts";

type ResolveContext = Parameters<typeof resolveDelegateModel>[0];
type RegistryModel = NonNullable<ResolveContext["model"]>;

const parentModel = { provider: "anthropic", id: "parent" } as RegistryModel;
const configuredModel = { provider: "opencode", id: "fable" } as RegistryModel;
const settingsDir = mkdtempSync(join(tmpdir(), "pi-delegate-test-"));
const noEvents = {
  emit() {},
  on() {
    return () => {};
  },
};

function eventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
    on(channel: string, listener: (data: unknown) => void) {
      const channelListeners = listeners.get(channel) ?? new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(listener);
    },
  };
}

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

function delegateSnapshot(
  overrides: Partial<DelegateSnapshot> = {},
): DelegateSnapshot {
  return {
    id: "delegate-1",
    status: "done",
    workspace: "read",
    output: "background result",
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
    ...overrides,
  };
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

test("registers run, session, and workflow tools", () => {
  const tools: Array<{
    name: string;
    executionMode?: "sequential" | "parallel";
    execute: unknown;
    renderCall?: unknown;
    renderResult?: unknown;
  }> = [];
  delegateExtension({
    events: noEvents,
    on() {},
    registerTool(registered: ToolDefinition) {
      tools.push(registered);
    },
  } as unknown as ExtensionAPI);

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["delegate_run", "delegate_session", "delegate_workflow"],
  );
  assert.ok(tools.every((tool) => tool.executionMode === "parallel"));
  assert.equal(typeof tools[0].execute, "function");
  assert.equal(typeof tools[0].renderCall, "function");
  assert.equal(typeof tools[0].renderResult, "function");
  const runProperties = (
    tools[0] as unknown as { parameters: { properties: object } }
  ).parameters.properties;
  const sessionProperties = (
    tools[1] as unknown as { parameters: { properties: object } }
  ).parameters.properties;
  assert.deepEqual(Object.keys(runProperties), [
    "task",
    "background",
    "effort",
    "workspace",
    "schema",
  ]);
  assert.deepEqual(Object.keys(sessionProperties), [
    "action",
    "id",
    "ids",
    "message",
  ]);
  assert.deepEqual(
    (
      sessionProperties as {
        action: { enum: string[] };
      }
    ).action.enum,
    ["list", "status", "wait", "send", "cancel"],
  );
});

test("background run returns immediately and list recovers a bounded task preview", async () => {
  const tools: ToolDefinition[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  delegateExtension({
    events: noEvents,
    on(event: string, handler: () => Promise<void>) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  const run = tools.find((tool) => tool.name === "delegate_run");
  const session = tools.find((tool) => tool.name === "delegate_session");
  assert.ok(run && session);
  const task = `inspect first line\n${"x".repeat(300)}`;

  try {
    const started = await run.execute(
      "run-1",
      { task, background: true },
      undefined,
      undefined,
      { ...fakeContext(), cwd: settingsDir } as ExtensionContext,
    );
    assert.match(
      started.content[0]?.type === "text" ? started.content[0].text : "",
      /delegate-1/,
    );
    const listed = await session.execute(
      "list-1",
      { action: "list" },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
    const text =
      listed.content[0]?.type === "text" ? listed.content[0].text : "";
    assert.match(text, /delegate-1.*inspect first line x+/);
    assert.doesNotMatch(text, /\n.*x/);
    assert.ok(text.length < 300);
    assert.equal((listed.details as { results: unknown[] }).results.length, 1);
  } finally {
    await shutdown?.();
  }
});

test("retains at most 64 settled workflows for process status", async () => {
  const events = eventBus();
  const tools: ToolDefinition[] = [];
  delegateExtension({
    events,
    on() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  const workflow = tools.find((tool) => tool.name === "delegate_workflow");
  assert.ok(workflow);
  const params = {
    stages: [
      {
        tasks: [
          {
            id: "blocked",
            task: "never starts",
            inputs: ["missing"],
          },
          { id: "also-blocked", task: "also never starts" },
        ],
      },
    ],
  };
  for (let index = 0; index < 65; index++) {
    await assert.rejects(
      workflow.execute(
        `workflow-${index}`,
        params,
        undefined,
        undefined,
        fakeContext() as ExtensionContext,
      ),
      /must reference an earlier-stage task/,
    );
  }

  const list = processStatusView({ events }).expanded;
  assert.equal(list.match(/^ {2}workflow-/gm)?.length, 64);
  assert.doesNotMatch(list, /workflow-1 /);
  assert.match(list, /workflow-65 \[error\]/);
  assert.match(
    processStatusView({ events }, "workflow-65").expanded,
    /must reference an earlier-stage task/,
  );
});

test("background delivery retries once and delivers at most once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const messages: Array<{ message: unknown; options: unknown }> = [];
  let attempts = 0;
  const delivery = new BackgroundDelivery(
    {
      sendMessage(message: unknown, options: unknown) {
        attempts++;
        if (attempts === 1) throw new Error("temporary send failure");
        messages.push({ message, options });
      },
    } as unknown as ExtensionAPI,
    async (snapshots) => snapshots.map((snapshot) => snapshot.output).join(),
  );
  let idle = false;
  delivery.setContext({ isIdle: () => idle } as ExtensionContext);
  delivery.enqueue(delegateSnapshot());
  idle = true;

  await delivery.flush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(25);
  await Promise.resolve();
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
});

test("background delivery batches distinct completed children", async () => {
  const messages: unknown[] = [];
  const delivery = new BackgroundDelivery({
    sendMessage(message: unknown) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI);
  delivery.setContext({ isIdle: () => false } as ExtensionContext);
  const base = delegateSnapshot({ output: "first child" });

  const firstReservation = delivery.reserve();
  const secondReservation = delivery.reserve();
  delivery.attach(firstReservation, base);
  const second = { ...base, id: "delegate-2", output: "second child" };
  delivery.attach(secondReservation, second);
  delivery.enqueue(base);
  delivery.enqueue(second);
  await delivery.flush();
  assert.equal(messages.length, 1);
  const content = (messages[0] as { content: string }).content;
  assert.match(content, /first child/);
  assert.match(content, /second child/);
  await delivery.flush();
  assert.equal(messages.length, 1);
  assert.doesNotThrow(() => {
    for (let index = 0; index < 64; index++) delivery.reserve();
  });
});

test("background delivery reruns after work arrives during a stale flush", async () => {
  const messages: unknown[] = [];
  let releaseRender!: () => void;
  const renderGate = new Promise<void>((resolve) => {
    releaseRender = resolve;
  });
  let renders = 0;
  const delivery = new BackgroundDelivery(
    {
      sendMessage(message: unknown) {
        messages.push(message);
      },
    } as unknown as ExtensionAPI,
    async (snapshots) => {
      renders++;
      if (renders === 1) await renderGate;
      return snapshots.map((snapshot) => snapshot.output).join(",");
    },
  );
  delivery.setContext({ isIdle: () => true } as ExtensionContext);
  const first = delegateSnapshot({ output: "first" });
  delivery.enqueue(first);
  await new Promise((resolve) => setTimeout(resolve, 0));
  delivery.consume([first]);
  delivery.enqueue({ ...first, id: "delegate-2", output: "second" });
  releaseRender();
  await eventually(() => messages.length === 1);
  assert.equal(renders, 2);
  assert.doesNotMatch((messages[0] as { content: string }).content, /first/);
  assert.match((messages[0] as { content: string }).content, /second/);
});

test("consuming a failing render prevents stale retries and diagnostics", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const diagnostics: string[] = [];
  const messages: unknown[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => diagnostics.push(String(message));
  let rejectThird!: (error: Error) => void;
  const thirdRender = new Promise<never>((_resolve, reject) => {
    rejectThird = reject;
  });
  let renders = 0;
  const delivery = new BackgroundDelivery(
    { sendMessage: (message: unknown) => messages.push(message) },
    async (snapshots) => {
      renders++;
      if (renders < 3) throw new Error("render failed");
      if (renders === 3) return thirdRender;
      return snapshots.map((snapshot) => snapshot.output).join(",");
    },
  );
  const consumed = delegateSnapshot({ output: "recovered by wait" });
  let idle = false;
  delivery.setContext({ isIdle: () => idle } as ExtensionContext);
  delivery.enqueue(consumed);
  idle = true;

  try {
    await delivery.flush();
    t.mock.timers.tick(25);
    await Promise.resolve();
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(renders, 3);

    delivery.consume([consumed]);
    delivery.enqueue(
      delegateSnapshot({ id: "delegate-2", output: "later result" }),
    );
    rejectThird(new Error("stale third render failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(renders, 4);
    assert.equal(messages.length, 1);
    assert.equal(diagnostics.length, 0);
    assert.match((messages[0] as { content: string }).content, /later result/);
    assert.doesNotMatch(
      (messages[0] as { content: string }).content,
      /recovered by wait/,
    );
  } finally {
    delivery.clear();
    console.error = originalError;
  }
});

test("background delivery retains exhausted failures for explicit recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => diagnostics.push(String(message));
  const delivery = new BackgroundDelivery(
    {
      sendMessage() {
        throw new Error("transport unavailable");
      },
    } as unknown as ExtensionAPI,
    async () => "settled",
  );
  let idle = false;
  delivery.setContext({ isIdle: () => idle } as ExtensionContext);
  const snapshot = delegateSnapshot({ output: "settled" });
  delivery.enqueue(snapshot);
  idle = true;

  try {
    await delivery.flush();
    t.mock.timers.tick(25);
    await Promise.resolve();
    t.mock.timers.tick(100);
    await Promise.resolve();
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /delegate-1/);
    assert.match(diagnostics[0], /transport unavailable/);
    assert.match(diagnostics[0], /delegate_session wait/);

    delivery.consume([snapshot]);
    await delivery.flush();
    assert.equal(diagnostics.length, 1);
  } finally {
    delivery.clear();
    console.error = originalError;
  }
});

test("exhausted delivery ignores later flushes while newer results get three attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const attempts = new Map<string, number>();
  const delivery = new BackgroundDelivery(
    {
      sendMessage(message: unknown) {
        const ids = (message as { details: { ids: string[] } }).details.ids;
        for (const id of ids) attempts.set(id, (attempts.get(id) ?? 0) + 1);
        throw new Error("offline");
      },
    } as unknown as ExtensionAPI,
    async (snapshots) => snapshots.map((snapshot) => snapshot.id).join(),
  );
  delivery.setContext({ isIdle: () => true } as ExtensionContext);
  delivery.enqueue(delegateSnapshot());
  await Promise.resolve();
  t.mock.timers.tick(25);
  await Promise.resolve();
  delivery.enqueue(delegateSnapshot({ id: "delegate-2" }));
  t.mock.timers.tick(100);
  await Promise.resolve();
  t.mock.timers.tick(100);
  await Promise.resolve();
  t.mock.timers.tick(100);
  await Promise.resolve();
  await delivery.flush();
  assert.equal(attempts.get("delegate-1"), 3);
  assert.equal(attempts.get("delegate-2"), 3);
  delivery.clear();
});

test("replacing an idle context restarts a stale render on the replacement", async () => {
  const sent: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let renders = 0;
  const delivery = new BackgroundDelivery(
    { sendMessage: (message: unknown) => sent.push(message) },
    async () => {
      if (++renders === 1) await gate;
      return "result";
    },
  );
  const first = { isIdle: () => true } as ExtensionContext;
  const second = { isIdle: () => true } as ExtensionContext;
  delivery.setContext(first);
  delivery.enqueue(delegateSnapshot());
  await Promise.resolve();
  delivery.setContext(second);
  release();
  await eventually(() => sent.length === 1);
  assert.equal(renders, 2);
});

test("background delivery clear cancels a scheduled retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const delivery = new BackgroundDelivery(
    {
      sendMessage() {
        attempts++;
        throw new Error("temporary failure");
      },
    } as unknown as ExtensionAPI,
    async () => "settled",
  );
  delivery.setContext({ isIdle: () => false } as ExtensionContext);
  delivery.enqueue(delegateSnapshot({ output: "settled" }));

  await delivery.flush();
  assert.equal(attempts, 1);
  delivery.clear();
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  assert.equal(attempts, 1);
});

test("background delivery reservations are bounded and released", () => {
  const delivery = new BackgroundDelivery({
    sendMessage() {},
  } as unknown as ExtensionAPI);
  const reservations = Array.from({ length: 64 }, () => delivery.reserve());
  assert.throws(() => delivery.reserve(), /64 tracked children/);
  delivery.release(reservations[0]);
  assert.doesNotThrow(() => delivery.reserve());
});

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
