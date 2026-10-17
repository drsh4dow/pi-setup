import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, suite, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import extension from "../index.ts";
import { RunOutcome } from "../launch.ts";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";

type AgentMessage = AgentEndEvent["messages"][number];

const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(RunOutcome));

const TASK = "Run seq 3 with bash, then reply with exactly: ALPHA DONE";

async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3000;

  while (!predicate() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }

  assert.ok(predicate(), message);
}

type AssistantReply = Extract<AgentMessage, { role: "assistant" }>;

function assistant(content: AssistantReply["content"], stopReason: AssistantReply["stopReason"]) {
  return unsafeFixture<AssistantReply>({ role: "assistant", content, stopReason });
}

// Effect reads the environment once per process, so every case shares one run directory.
const runDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));

await writeFile(path.join(runDirectory, "task.md"), TASK);

Object.assign(process.env, {
  PI_SUBAGENT_RUN: runDirectory,
  PI_SUBAGENT_NAME: "alpha",
  PI_SUBAGENT_DEPTH: "1",
});

// The child reports its label to HERDR_PANE_ID; a test must never reach the caller's herdr.
delete process.env.HERDR_PANE_ID;

const outcomeFile = path.join(runDirectory, "outcome.json");

async function startChild() {
  await rm(outcomeFile, { force: true });

  const adapter = extensionTestAdapter();
  const sent: Parameters<ExtensionAPI["sendUserMessage"]>[0][] = [];
  const notices: string[] = [];
  let shutdowns = 0;

  extension({
    ...adapter.api,
    sendUserMessage(content) {
      sent.push(content);
    },
  });

  const ctx = unsafeFixture<ExtensionContext>({
    mode: "tui",
    ui: unsafeFixture<ExtensionContext["ui"]>({
      notify(message) {
        notices.push(message);
      },
    }),
    shutdown() {
      shutdowns += 1;
    },
  });

  return {
    ctx,
    emit: adapter.emit,
    notices,
    sent,
    shutdowns: () => shutdowns,
    outcome: async () => decodeOutcome(await readFile(outcomeFile, "utf8")),
  };
}

suite("subagent child", () => {
  after(() => rm(runDirectory, { recursive: true, force: true }));

  test("rejects typed input and points at the parent", async () => {
    const child = await startChild();

    const result = await child.emit(
      "input",
      { type: "input", text: "delete everything", source: "interactive" },
      child.ctx,
    );

    assert.deepEqual(result, { action: "handled" });
    assert.deepEqual(child.notices, ["Read-only subagent. Steer it from its parent."]);
  });

  test("lets extension input through", async () => {
    const child = await startChild();

    const result = await child.emit(
      "input",
      { type: "input", text: TASK, source: "extension" },
      child.ctx,
    );

    assert.deepEqual(result, { action: "continue" });
    assert.deepEqual(child.notices, []);
  });

  test("a completed run writes the last assistant text and shuts down", async () => {
    const child = await startChild();

    await child.emit("session_start", { type: "session_start", reason: "startup" }, child.ctx);
    await eventually(() => child.sent.length === 1, "the task is delivered");
    assert.deepEqual(child.sent, [TASK]);

    await child.emit(
      "agent_end",
      {
        type: "agent_end",
        messages: [
          assistant(
            [
              { type: "thinking", thinking: "planning" },
              { type: "text", text: "ALPHA DONE" },
            ],
            "stop",
          ),
        ],
      },
      child.ctx,
    );
    await child.emit("agent_settled", { type: "agent_settled", aborted: false }, child.ctx);

    assert.deepEqual(await child.outcome(), { kind: "completed", report: "ALPHA DONE" });
    assert.equal(child.shutdowns(), 1);
  });

  test("an aborted run reports the latest text, which precedes the aborted tool call", async () => {
    const child = await startChild();

    await child.emit("session_start", { type: "session_start", reason: "startup" }, child.ctx);
    await eventually(() => child.sent.length === 1, "the task is delivered");

    await child.emit(
      "agent_end",
      {
        type: "agent_end",
        messages: [
          assistant([{ type: "text", text: "STARTING" }], "toolUse"),
          assistant([], "aborted"),
        ],
      },
      child.ctx,
    );
    await child.emit("agent_settled", { type: "agent_settled", aborted: true }, child.ctx);

    assert.deepEqual(await child.outcome(), { kind: "aborted", report: "STARTING" });
    assert.equal(child.shutdowns(), 1);
  });
});
