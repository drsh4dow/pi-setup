import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createEventBus,
  type EventBus,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import extension from "../../herdr-agent-state.ts";
import { extensionTestAdapter, unsafeFixture } from "../adapter.ts";

const reportSchema = Schema.Struct({
  id: Schema.String,
  method: Schema.Literals(["pane.report_agent", "pane.report_agent_session"]),
  params: Schema.Struct({
    state: Schema.optional(Schema.Literals(["idle", "working", "blocked"])),
    message: Schema.optional(Schema.String),
    agent_session_path: Schema.optional(Schema.String),
  }),
});

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(reportSchema));

type Report = typeof reportSchema.Type;

type Reply =
  | { id: string; result: Record<string, never> }
  | { id: string; error: { code: string; message: string } };

type Lifecycle = "session_start" | "session_shutdown" | "agent_start" | "agent_settled";

interface Scenario {
  ctx: ExtensionContext;
  emit(name: Lifecycle, context?: ExtensionContext): Promise<void>;
  events: EventBus;
  eventually(predicate: () => boolean, message: string): Promise<void>;
  reports: Report[];
  states(): Report[];
  setIdle(value: boolean): void;
  respondWith(handler: (request: Report) => Reply | undefined): void;
}

async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3500;

  while (!predicate() && Date.now() < deadline) {
    // Each poll observes delivery by the socket server before trying again.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }

  assert.ok(predicate(), message);
}

function acknowledge(request: Report): Reply {
  return { id: request.id, result: {} };
}

export async function run(check: (scenario: Scenario) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "herdr-test-"));
  const socketPath = path.join(directory, "herdr.sock");
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "test:p1";
  process.env.HERDR_SOCKET_PATH = socketPath;
  const reports: Report[] = [];
  const sockets = new Set<net.Socket>();

  let respond: (request: Report) => Reply | undefined = acknowledge;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;

      if (!input.includes("\n")) return;
      const request = decodeReport(input.trim());
      reports.push(request);
      const response = respond(request);

      if (response === undefined) socket.destroy();
      else socket.end(`${JSON.stringify(response)}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const adapter = extensionTestAdapter();
  const events = createEventBus();
  let idle = true;

  const ctx = unsafeFixture<ExtensionContext>({
    mode: "tui",
    isIdle: () => idle,
    sessionManager: unsafeFixture<ExtensionContext["sessionManager"]>({
      getSessionFile: () => "/tmp/herdr-test-session.jsonl",
      getSessionId: () => "herdr-test-session",
    }),
  });

  const emit = async (name: Lifecycle, context = ctx) => {
    switch (name) {
      case "session_start":
        await adapter.emit(name, { type: name, reason: "startup" }, context);
        break;
      case "session_shutdown":
        await adapter.emit(name, { type: name, reason: "quit" }, context);
        break;
      case "agent_start":
        await adapter.emit(name, { type: name }, context);
        break;
      case "agent_settled":
        await adapter.emit(name, { type: name }, context);
        break;
    }
  };

  try {
    extension({ ...adapter.api, events });
    await check({
      ctx,
      emit,
      events,
      eventually,
      reports,
      states: () => reports.filter((report) => report.method === "pane.report_agent"),
      setIdle(value) {
        idle = value;
      },
      respondWith(handler) {
        respond = handler;
      },
    });
  } finally {
    await emit("session_shutdown");

    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
