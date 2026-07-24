import assert from "node:assert/strict";
import test from "node:test";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionCommandContext,
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
  detail = `${id} detail`,
) {
  return { id, kind, active, summary, detail: () => detail };
}

test("collapsed lists active entries while expanded lists every tracked entry", () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "delegate", () => [
    activity("d1", "subagents", true, "[running] map repository"),
    activity("d2", "subagents", false, "[done] review result"),
    activity("w1", "workflows", false, "[done] scan"),
  ]);
  registerProcessStatusSource({ events }, "terminals", () => [
    activity("t1", "terminals", true, "[running] test watcher"),
    activity("t2", "terminals", false, "[failed] build"),
  ]);

  const view = processStatusView({ events });
  assert.match(view.collapsed, /subagents:\n {2}d1 \[running\]/);
  assert.doesNotMatch(view.collapsed, /d2|w1|t2/);
  assert.match(view.expanded, /d2 \[done\]/);
  assert.match(view.expanded, /w1 \[done\]/);
  assert.match(view.expanded, /t2 \[failed\]/);
  for (const line of view.expanded
    .split("\n")
    .filter((line) => /^ {2}\w/.test(line))) {
    assert.match(line, /^ {2}[A-Za-z0-9][A-Za-z0-9_-]* /);
  }
});

test("inspects one stable id with a bounded one-time detail snapshot", () => {
  const events = eventBus();
  let detail = `Tool read input:\n{ path: 'a.ts' }\n\nTool read output:\nsource\n${"é".repeat(40_000)}\ntail`;
  registerProcessStatusSource({ events }, "delegate", () => [
    activity("d1", "subagents", true, "[running] inspect", detail),
  ]);

  const view = processStatusView({ events }, "d1");
  detail = "changed after collection";
  assert.equal(view.collapsed, view.expanded);
  assert.match(view.collapsed, /^d1 \[running\] inspect/);
  assert.match(view.collapsed, /Tool read input/);
  assert.match(view.collapsed, /\[truncated\][\s\S]*tail$/);
  assert.ok(Buffer.byteLength(view.collapsed) <= 64 * 1024 + 100);
  assert.doesNotMatch(view.collapsed, /�|changed after collection/);
});

test("reports unknown and duplicate ids without hiding valid entries", () => {
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
  assert.match(
    processStatusView({ events }, "missing").collapsed,
    /error: unknown-id\nid: missing\naction: \/ps/,
  );
});

test("isolates source failures and discloses collection limits", () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "broken", () => {
    throw new Error("registry unavailable");
  });
  for (let index = 0; index < 16; index++) {
    registerProcessStatusSource({ events }, `source-${index}`, () => []);
  }

  const text = processStatusView({ events }).expanded;
  assert.match(text, /errors:\n {2}broken: registry unavailable/);
  assert.match(text, /sources:\n {2}omitted: 1/);
});

test("keeps active entries visible when a group reaches its display bound", () => {
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
  assert.match(
    processStatusView({ events }, "current").collapsed,
    /current detail/,
  );
  assert.match(view.expanded, /omitted: 1/);
});

test("rejects runaway sources and bounds groups without hiding later kinds", () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "runaway", () =>
    Array.from({ length: 193 }, (_, index) =>
      activity(`d${index}`, "subagents", true, `delegate ${index}`),
    ),
  );
  registerProcessStatusSource({ events }, "busy", () => [
    ...Array.from({ length: 65 }, (_, index) =>
      activity(`s${index}`, "subagents", true, `delegate ${index}`),
    ),
    activity("t1", "terminals", true, "watcher"),
  ]);

  const text = processStatusView({ events }).expanded;
  assert.match(text, /runaway: limit=activities count=193 max=192/);
  assert.match(text, /omitted: 1/);
  assert.match(text, /terminals:\n {2}t1 watcher/);
});

test("/ps appends an expandable entry and /ps <id> appends its detail", async () => {
  const events = eventBus();
  registerProcessStatusSource({ events }, "delegate", () => [
    activity("d1", "subagents", true, "[running] inspect", "recent tools"),
    activity("d2", "subagents", false, "[done] result"),
  ]);
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let renderer: EntryRenderer | undefined;
  const appended: unknown[] = [];
  extension({
    events,
    appendEntry(_type: string, data: unknown) {
      appended.push(data);
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

  const ctx = { mode: "tui", hasUI: true } as ExtensionCommandContext;
  await handler?.("", ctx);
  await handler?.("d1", ctx);
  assert.equal(appended.length, 2);
  assert.deepEqual(appended[0], processStatusView({ events }));
  assert.match(
    (appended[1] as { collapsed: string }).collapsed,
    /recent tools/,
  );
  assert.ok(renderer);
  const entry = { data: appended[0] } as never;
  const theme = {
    bg: (_color: string, text: string) => text,
    fg: (_color: string, text: string) => text,
  } as never;
  const collapsed = renderer(entry, { expanded: false }, theme)
    ?.render(120)
    .join("\n");
  const expanded = renderer(entry, { expanded: true }, theme)
    ?.render(120)
    .join("\n");
  assert.match(collapsed ?? "", /d1 \[running\]/);
  assert.doesNotMatch(collapsed ?? "", /d2 \[done\]/);
  assert.match(expanded ?? "", /d2 \[done\]/);
});
