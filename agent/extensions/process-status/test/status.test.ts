import assert from "node:assert/strict";
import test from "node:test";
import {
  type EntryRenderer,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionEvent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { processStatusView, registerProcessStatusSource } from "../status.ts";

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

function activity(
  id: string,
  kind: "subagents" | "workflows" | "terminals",
  active: boolean,
  summary: string,
  tokens = 0,
  cost = 0,
  detail?: string,
) {
  return {
    id,
    kind,
    active,
    summary,
    usage: { tokens, cost },
    detail: detail === undefined ? undefined : () => detail,
  };
}

test("lists work and aggregate usage on one line", () => {
  const events = eventBus();
  registerProcessStatusSource(
    { events },
    "delegate",
    () => [
      activity("d1", "subagents", true, "[running] read · model", 1200, 0.1),
      activity("d2", "subagents", false, "[done] read · model", 800, 0.2),
      activity("w1", "workflows", false, "[done] tasks=2/2"),
    ],
    () => ({ tokens: 2000, cost: 0.3 }),
  );
  registerProcessStatusSource({ events }, "terminals", () => [
    activity("t1", "terminals", true, "[running] test watcher"),
    activity("t2", "terminals", false, "[failed] build"),
  ]);

  const view = processStatusView({ events });
  assert.equal(view.collapsed.split("\n").length, 1);
  assert.equal(view.expanded.split("\n").length, 1);
  assert.match(view.collapsed, /^2,000 tokens · \$0\.3000/);
  assert.match(view.collapsed, /d1 \[running\]/);
  assert.match(view.collapsed, /t1 \[running\]/);
  assert.doesNotMatch(view.collapsed, /d2|w1|t2/);
  assert.match(view.expanded, /d2 \[done\]/);
  assert.match(view.expanded, /w1 \[done\]/);
  assert.match(view.expanded, /t2 \[failed\]/);
});

test("shows one worker's usage and bounded diagnostics", () => {
  const events = eventBus();
  let detail = `Tool read input:\n{ path: 'a.ts' }\n\nTool read output:\nsource\n${"é".repeat(40_000)}\ntail`;
  registerProcessStatusSource({ events }, "delegate", () => [
    activity(
      "d1",
      "subagents",
      true,
      "[running] read · model",
      12_345,
      0.45678,
      detail,
    ),
  ]);

  const view = processStatusView({ events }, "d1");
  detail = "changed after collection";
  assert.equal(view.collapsed, view.expanded);
  assert.match(view.collapsed, /^12,345 tokens · \$0\.4568 · d1 \[running\]/);
  assert.match(view.collapsed, /Tool read input/);
  assert.match(view.collapsed, /\[truncated\][\s\S]*tail$/);
  assert.ok(Buffer.byteLength(view.collapsed) <= 64 * 1024 + 150);
  assert.doesNotMatch(view.collapsed, /�|changed after collection/);
});

test("reports a bounded detail loader failure", () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "delegate", () => [
    {
      id: "d1",
      kind: "subagents",
      active: true,
      summary: "[failed] read",
      detail: () => {
        throw new Error("activity unavailable\nretry later");
      },
    },
  ]);

  assert.match(
    processStatusView({ events }, "d1").collapsed,
    /detail-error: activity unavailable retry later$/,
  );
});

test("reports unknown and duplicate ids without adding lines", () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "first", () => [
    activity("d1", "subagents", true, "first"),
  ]);
  registerProcessStatusSource({ events }, "second", () => [
    activity("d1", "terminals", true, "duplicate"),
    activity("t1", "terminals", true, "valid"),
  ]);

  const list = processStatusView({ events }).expanded;
  assert.match(list, /d1 first/);
  assert.match(list, /t1 valid/);
  assert.match(list, /second: error=duplicate-id id=d1/);
  const unknown = processStatusView({ events }, "missing").collapsed;
  assert.equal(unknown, "error: unknown-id · id: missing · action: /ps");
  assert.equal(unknown.split("\n").length, 1);
});

test("isolates source failures and discloses collection limits inline", () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "broken", () => {
    throw new Error("registry unavailable");
  });
  registerProcessStatusSource({ events }, "runaway", () =>
    Array.from({ length: 193 }, (_, index) =>
      activity(`d${index}`, "subagents", true, `delegate ${index}`),
    ),
  );
  for (let index = 0; index < 15; index++) {
    registerProcessStatusSource({ events }, `source-${index}`, () => []);
  }

  const text = processStatusView({ events }).expanded;
  assert.match(text, /1 omitted/);
  assert.match(text, /broken: registry unavailable/);
  assert.match(text, /runaway: limit=activities count=193 max=192/);
  assert.equal(text.split("\n").length, 1);
});

test("keeps active entries when a group reaches its display bound", () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "history", () => [
    ...Array.from({ length: 64 }, (_, index) =>
      activity(`old-${index}`, "workflows", false, "[done] old workflow"),
    ),
    activity("current", "workflows", true, "[running] current workflow"),
  ]);

  const view = processStatusView({ events });
  assert.match(view.collapsed, /current \[running\]/);
  assert.match(view.expanded, /current \[running\]/);
  assert.match(view.expanded, /1 omitted/);
});

test("renders compact lists, multiline details, and compounded worker cost", async () => {
  const events = eventBus();
  registerProcessStatusSource(
    { events },
    "delegate",
    () => [
      activity(
        "d1",
        "subagents",
        true,
        "[running] read",
        200,
        0.75,
        "task: inspect\n\nactivity:\nread source",
      ),
      activity("d2", "subagents", false, "[done] review"),
    ],
    () => ({ tokens: 200, cost: 0.75 }),
  );
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let renderer: EntryRenderer | undefined;
  let footerFactory: Parameters<ExtensionContext["ui"]["setFooter"]>[0];
  const lifecycle = new Map<
    string,
    (event: ExtensionEvent, ctx: ExtensionContext) => unknown
  >();
  const appended: unknown[] = [];
  extension({
    events,
    appendEntry(_type: string, data: unknown) {
      appended.push(data);
    },
    getThinkingLevel: () => "high",
    on(
      event: string,
      callback: (event: ExtensionEvent, ctx: ExtensionContext) => unknown,
    ) {
      lifecycle.set(event, callback);
    },
    registerEntryRenderer(_type: string, value: EntryRenderer) {
      renderer = value;
    },
    registerCommand(
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      assert.equal(name, "ps");
      handler = command.handler;
    },
  } as unknown as ExtensionAPI);

  const parentEntry = {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.25 },
      },
    },
  };
  const ui = {
    setFooter(factory: typeof footerFactory) {
      footerFactory = factory;
    },
  };
  const model = {
    id: "test-model",
    provider: "test-provider",
    contextWindow: 1000,
    reasoning: false,
  };
  const context = {
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry: {
      isUsingOAuth(candidate: unknown) {
        assert.equal(candidate, model);
        return false;
      },
    },
    sessionManager: {
      getEntries: () => [parentEntry],
      getCwd: () => "/tmp/project",
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    ui,
  } as unknown as ExtensionContext;
  lifecycle.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    context,
  );

  const ctx = { mode: "tui", hasUI: true } as ExtensionCommandContext;
  await handler?.("", ctx);
  await handler?.("d1", ctx);
  assert.equal(appended.length, 2);
  assert.ok(renderer);
  const theme = {
    bg: (_color: string, text: string) => text,
    fg: (_color: string, text: string) => text,
  } as never;
  const rendered = renderer(
    { data: appended[0] } as never,
    { expanded: false },
    theme,
  )?.render(45);
  assert.equal(rendered?.length, 1);
  assert.ok((rendered?.[0]?.length ?? 0) <= 45);
  assert.doesNotMatch(rendered?.join("\n") ?? "", /d2/);
  const expanded = renderer(
    { data: appended[0] } as never,
    { expanded: true },
    theme,
  )
    ?.render(45)
    .join("\n");
  assert.match(expanded ?? "", /d2 \[done\] review/);
  const detail = renderer(
    { data: appended[1] } as never,
    { expanded: false },
    theme,
  )
    ?.render(80)
    .join("\n");
  assert.match(detail ?? "", /task: inspect[\s\S]*activity:[\s\S]*read source/);

  assert.ok(footerFactory);
  initTheme();
  const footer = footerFactory({ requestRender() {} } as never, {} as never, {
    getGitBranch: () => null,
    getExtensionStatuses: () => new Map(),
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  });
  assert.match(footer.render(100).join("\n"), /\$1\.000/);
  footer.dispose?.();
});
