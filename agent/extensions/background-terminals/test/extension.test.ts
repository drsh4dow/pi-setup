import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { processIsGone } from "../../test/process.ts";
import extension, { BackgroundTerminalDelivery } from "../index.ts";
import { MAX_TRACKED, type TerminalSnapshot } from "../manager.ts";

const noEvents = {
  emit() {},
  on() {
    return () => {};
  },
};

function registeredTools() {
  const tools: ToolDefinition[] = [];
  extension({
    events: noEvents,
    on() {},
    registerCommand() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  return tools as unknown as Array<{
    execute: (...args: unknown[]) => Promise<unknown>;
  }>;
}

test("registers four parallel tools and lifecycle hooks", () => {
  const tools: ToolDefinition[] = [];
  const events = new Set<string>();
  extension({
    events: noEvents,
    on(name: string) {
      events.add(name);
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["bg_start", "bg_status", "bg_list", "bg_kill"],
  );
  assert.ok(tools.every((tool) => tool.executionMode === "parallel"));
  assert.ok(
    events.has("session_start") &&
      events.has("agent_end") &&
      events.has("agent_settled") &&
      events.has("session_shutdown"),
  );
});

test("no-UI runs stop terminals before release and can start another run", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  extension({
    events: noEvents,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  const context = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => false,
  } as ExtensionContext;
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    context,
  );
  const start = tools[0] as unknown as {
    execute: (...args: unknown[]) => Promise<{
      details: { id: string; pid: number };
    }>;
  };
  const first = await start.execute(
    "1",
    { command: "sleep 30", title: "first" },
    undefined,
    undefined,
    context,
  );
  try {
    assert.ok(first.details.pid);
    await handlers.get("agent_end")?.(
      { type: "agent_end", messages: [] },
      context,
    );
    assert.ok(processIsGone(first.details.pid));
    const second = await start.execute(
      "2",
      { command: "true", title: "second" },
      undefined,
      undefined,
      context,
    );
    assert.ok(second.details.pid);
    assert.notEqual(second.details.id, first.details.id);
  } finally {
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      context,
    );
  }
});

test("session shutdown clears status, kills processes, and permits restart", async () => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const statuses: Array<string | undefined> = [];
  extension({
    events: noEvents,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI);
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => false,
    ui: {
      setStatus(_id: string, status?: string) {
        statuses.push(status);
      },
    },
  } as unknown as ExtensionContext;
  const start = tools[0] as unknown as {
    execute: (...args: unknown[]) => Promise<{
      details: { pid: number };
    }>;
  };
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    context,
  );
  const first = await start.execute(
    "1",
    { command: "sleep 30", title: "session one" },
    undefined,
    undefined,
    context,
  );
  await handlers.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "new" },
    context,
  );
  assert.ok(processIsGone(first.details.pid));
  assert.equal(statuses.at(-1), undefined);
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "new" },
    context,
  );
  const second = await start.execute(
    "2",
    { command: "true", title: "session two" },
    undefined,
    undefined,
    context,
  );
  assert.ok(second.details.pid);
  await handlers.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "quit" },
    context,
  );
});

test("successful completions are passive while failures trigger a turn", async () => {
  const deliveries: Array<{ options: { triggerTurn: boolean } }> = [];
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  extension({
    events: noEvents,
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    sendMessage(_message: unknown, options: unknown) {
      deliveries.push({ options: options as { triggerTurn: boolean } });
    },
  } as unknown as ExtensionAPI);
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => true,
    ui: { setStatus() {} },
  } as unknown as ExtensionContext;
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    context,
  );
  const start = tools[0] as unknown as {
    execute: (...args: unknown[]) => Promise<unknown>;
  };
  try {
    await start.execute(
      "1",
      { command: "true", title: "silent success" },
      undefined,
      undefined,
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(deliveries.length, 0);
    await start.execute(
      "2",
      { command: "printf ok", title: "success" },
      undefined,
      undefined,
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(deliveries.at(-1)?.options.triggerTurn, false);
    await start.execute(
      "3",
      { command: "false", title: "failure" },
      undefined,
      undefined,
      context,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(deliveries.at(-1)?.options.triggerTurn, true);
  } finally {
    await handlers.get("session_shutdown")?.(
      { type: "session_shutdown", reason: "quit" },
      context,
    );
  }
});

test("completion delivery is suppressible and closed delivery stays closed", async () => {
  const messages: unknown[] = [];
  const delivery = new BackgroundTerminalDelivery({
    sendMessage(message: unknown) {
      messages.push(message);
    },
  } as ExtensionAPI);
  delivery.setContext({ isIdle: () => false } as ExtensionContext);
  const snapshot = {
    id: "bt-1",
    title: "x",
    command: "true",
    cwd: "/",
    state: "done",
    createdAt: 0,
    settledAt: 1,
    exitCode: 0,
    stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
    stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
  } as const;
  delivery.enqueue(snapshot);
  delivery.consume([snapshot.id]);
  await delivery.flush();
  assert.equal(messages.length, 0);
  delivery.enqueue(snapshot);
  delivery.clear();
  await delivery.flush();
  assert.equal(messages.length, 0);
});

test("bounds complete delivery batches with worst-case metadata", async () => {
  const messages: Array<{
    content: string;
    details: { ids: string[] };
  }> = [];
  const delivery = new BackgroundTerminalDelivery({
    sendMessage(message: unknown) {
      messages.push(message as { content: string; details: { ids: string[] } });
    },
  } as ExtensionAPI);
  delivery.setContext({ isIdle: () => false } as ExtensionContext);
  for (let index = 0; index < MAX_TRACKED; index++)
    delivery.enqueue({
      id: `bt-${index}`,
      title: "x".repeat(80),
      command: "true",
      cwd: `/${"w".repeat(4_094)}`,
      state: "failed",
      createdAt: 0,
      error: "e".repeat(4_096),
      stdout: {
        text: "é".repeat(20_000),
        totalBytes: 40_000,
        truncatedBytes: 0,
      },
      stderr: {
        text: "é".repeat(20_000),
        totalBytes: 40_000,
        truncatedBytes: 0,
      },
    } as TerminalSnapshot);
  await delivery.flush();
  assert.ok(messages.length > 1);
  assert.ok(
    messages.every(
      (message) => Buffer.byteLength(message.content) <= 256 * 1024,
    ),
  );
  assert.deepEqual(
    messages.flatMap((message) => message.details.ids),
    Array.from({ length: MAX_TRACKED }, (_, index) => `bt-${index}`),
  );
  assert.ok(messages.every((message) => !message.content.includes("�")));
});

test("retries completion delivery three times and exposes final failure", async () => {
  let attempts = 0;
  let idle = false;
  const diagnostics: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => diagnostics.push(String(message));
  const delivery = new BackgroundTerminalDelivery({
    sendMessage() {
      attempts++;
      throw new Error("\u001b[31m\nunavailable\u202e");
    },
  } as unknown as ExtensionAPI);
  try {
    delivery.setContext({ isIdle: () => idle } as ExtensionContext);
    delivery.enqueue({
      id: "bt-retry",
      title: "retry",
      command: "false",
      cwd: "/",
      state: "failed",
      createdAt: 0,
      exitCode: 1,
      stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
      stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
    });
    idle = true;
    await delivery.flush();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(attempts, 3);
    assert.match(delivery.problem ?? "", /bt-retry/);
    assert.equal(diagnostics.length, 1);
    assert.ok(!diagnostics[0].includes("\u001b"));
    assert.ok(!diagnostics[0].includes("\u202e"));
    assert.ok(!diagnostics[0].includes("\n"));
  } finally {
    delivery.clear();
    console.error = originalError;
  }
});

test("sanitizes displayed data and list details omit process output", async () => {
  const [start, status, list, kill] = registeredTools();
  const ctx = { cwd: process.cwd() };
  const started = (await start.execute(
    "1",
    {
      command: `node -e 'process.stdout.write(String.fromCharCode(128) + "bad")'`,
      title: "\u001b[31mred\u202e\u200b",
    },
    undefined,
    undefined,
    ctx,
  )) as { details: { id: string }; content: [{ text: string }] };
  assert.ok(!started.content[0].text.includes("\u001b"));
  assert.ok(!started.content[0].text.includes("\u202e"));
  assert.ok(!started.content[0].text.includes("\u200b"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const result = (await status.execute("2", { id: started.details.id })) as {
    details: Record<string, unknown>;
    content: [{ text: string }];
  };
  assert.doesNotMatch(result.content[0].text, /[\u0080-\u009f]/u);
  assert.match(
    result.content[0].text,
    /^bt-\d+ \[done\][\s\S]*command: node -e/,
  );
  assert.ok(!("stdout" in result.details));
  assert.ok(!("stderr" in result.details));
  const listed = (await list.execute("3", {})) as {
    details: { terminals: Array<Record<string, unknown>> };
  };
  assert.ok(!("stdout" in listed.details.terminals[0]));
  assert.ok(!("stderr" in listed.details.terminals[0]));
  for (const [tool, params] of [
    [status, { id: "bad\n\u202eid" }],
    [kill, { ids: ["bad\n\u202eid"] }],
  ] as const) {
    await assert.rejects(tool.execute("4", params), (error: Error) => {
      assert.ok(!error.message.includes("\n"));
      assert.ok(!error.message.includes("\u202e"));
      return true;
    });
  }
  await assert.rejects(
    start.execute(
      "5",
      { command: "true", title: "bad cwd", working_dir: "bad\n\u202edir" },
      undefined,
      undefined,
      ctx,
    ),
    (error: Error) => {
      assert.ok(!error.message.includes("\n"));
      assert.ok(!error.message.includes("\u202e"));
      return true;
    },
  );
});

test("pre-aborted bg_kill does not start termination", async () => {
  const tools = registeredTools();
  const started = (await tools[0].execute(
    "1",
    { command: "sleep 30", title: "pre-abort" },
    undefined,
    undefined,
    { cwd: process.cwd() },
  )) as { details: { id: string } };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tools[3].execute("2", { ids: [started.details.id] }, controller.signal),
    /before termination started/,
  );
  const status = (await tools[1].execute("3", {
    id: started.details.id,
  })) as { content: [{ text: string }] };
  assert.match(status.content[0].text, /\[running\]/);
  await tools[3].execute("4", { ids: [started.details.id] });
});

test("aborted bg_kill wait does not cancel termination", async () => {
  const tools = registeredTools();
  const start = tools[0];
  const kill = tools[3];
  const status = tools[1];
  const ctx = { cwd: process.cwd() };
  const started = (await start.execute(
    "1",
    { command: "sleep 30", title: "abort" },
    undefined,
    undefined,
    ctx,
  )) as { details: { id: string } };
  const id = started.details.id;
  const controller = new AbortController();
  const waiting = kill.execute("2", { ids: [id] }, controller.signal);
  controller.abort();
  await assert.rejects(waiting, /termination continues/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = (await status.execute("3", { id })) as {
    content: [{ text: string }];
  };
  assert.match(result.content[0].text, /\[killed\]/);
});
