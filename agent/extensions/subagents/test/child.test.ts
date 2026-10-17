import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, suite, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import extension, { type SubagentChildOptions } from "../index.ts";
import { RunOutcome } from "../launch.ts";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";

type AgentMessage = AgentEndEvent["messages"][number];

const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(RunOutcome));

const TASK = "Run seq 3 with bash, then reply with exactly: ALPHA DONE";

const F12 = "\u001b[24~";

const ESCAPE = "\u001b";

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

delete process.env.HERDR_PANE_ID;

const runDirectories: string[] = [];

interface ChildFixture {
  readonly options?: SubagentChildOptions;
  readonly withoutModel?: boolean;
  readonly claimedElsewhere?: boolean;
}

async function startChild({
  options = { taskStartTimeout: "200 millis" },
  withoutModel = false,
  claimedElsewhere = false,
}: ChildFixture = {}) {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
  const outcomeFile = path.join(runDirectory, "outcome.json");

  runDirectories.push(runDirectory);
  await writeFile(path.join(runDirectory, "task.md"), TASK);

  if (claimedElsewhere) await writeFile(path.join(runDirectory, "claim"), "1");

  Object.assign(process.env, {
    PI_SUBAGENT_RUN: runDirectory,
    PI_SUBAGENT_NAME: "alpha",
    PI_SUBAGENT_DEPTH: "1",
  });

  const adapter = extensionTestAdapter();
  const sent: Parameters<ExtensionAPI["sendUserMessage"]>[0][] = [];
  const notices: string[] = [];
  const terminalInput: TerminalInputHandler[] = [];
  let shutdowns = 0;

  extension(
    {
      ...adapter.api,
      sendUserMessage(content) {
        sent.push(content);
      },
    },
    options,
  );

  const ctx = unsafeFixture<ExtensionContext>({
    mode: "tui",
    model: withoutModel
      ? undefined
      : unsafeFixture<NonNullable<ExtensionContext["model"]>>({ provider: "anthropic" }),
    modelRegistry: unsafeFixture<ExtensionContext["modelRegistry"]>({
      getProviderAuthStatus: () => ({ configured: true }),
    }),
    isIdle: () => true,
    ui: unsafeFixture<ExtensionContext["ui"]>({
      notify(message) {
        notices.push(message);
      },
      onTerminalInput(handler) {
        terminalInput.push(handler);

        return () => {};
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
    type: (data: string) => {
      const [handler] = terminalInput;
      assert.ok(handler, "the child filters terminal input");

      return handler(data);
    },
    async start() {
      await adapter.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
      await adapter.emit(
        "resources_discover",
        { type: "resources_discover", cwd: runDirectory, reason: "startup" },
        ctx,
      );
    },
    hasOutcome: async () => (await stat(outcomeFile).catch(() => undefined)) !== undefined,
    outcome: async () => decodeOutcome(await readFile(outcomeFile, "utf8")),
  };
}

suite("subagent child", () => {
  after(() =>
    Promise.all(
      runDirectories.map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5 }),
      ),
    ),
  );

  test("typed keys never reach Pi, and Escape still aborts", async () => {
    const child = await startChild();

    await child.start();

    for (const key of [..."!touch /tmp/bypass".split(""), "\r", "\u0010", "\u001b[Z"]) {
      assert.deepEqual(child.type(key), { consume: true }, `key ${JSON.stringify(key)}`);
    }

    assert.equal(child.type(ESCAPE), undefined);
    assert.deepEqual(child.notices, ["Read-only subagent. Steer it from its parent."]);
  });

  test("rejects typed prompts and lets extension input through", async () => {
    const child = await startChild();

    await child.start();

    assert.deepEqual(
      await child.emit(
        "input",
        { type: "input", text: "delete everything", source: "interactive" },
        child.ctx,
      ),
      { action: "handled" },
    );
    assert.deepEqual(
      await child.emit("input", { type: "input", text: TASK, source: "extension" }, child.ctx),
      { action: "continue" },
    );
  });

  test("a completed run writes what pi --print prints and shuts down", async () => {
    const child = await startChild();

    await child.start();
    await eventually(() => child.sent.length === 1, "the task is delivered");
    assert.deepEqual(child.sent, [TASK]);

    await child.emit("agent_start", { type: "agent_start" }, child.ctx);
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

    assert.deepEqual(await child.outcome(), { kind: "completed", report: "ALPHA DONE\n" });
    assert.equal(child.shutdowns(), 1);
  });

  test("a reply cut at the token limit keeps its text and fails, as in print mode", async () => {
    const child = await startChild();

    await child.start();
    await eventually(() => child.sent.length === 1, "the task is delivered");
    await child.emit("agent_start", { type: "agent_start" }, child.ctx);
    await child.emit(
      "agent_end",
      { type: "agent_end", messages: [assistant([{ type: "text", text: "PARTIAL" }], "length")] },
      child.ctx,
    );
    await child.emit("agent_settled", { type: "agent_settled", aborted: false }, child.ctx);

    assert.deepEqual(await child.outcome(), { kind: "truncated", report: "PARTIAL\n" });
  });

  test("an aborted run reports the latest text, which precedes the aborted tool call", async () => {
    const child = await startChild();

    await child.start();
    await eventually(() => child.sent.length === 1, "the task is delivered");
    await child.emit("agent_start", { type: "agent_start" }, child.ctx);
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

    assert.deepEqual(await child.outcome(), { kind: "aborted", report: "STARTING\n" });
    assert.equal(child.shutdowns(), 1);
  });

  test("processes the child starts do not inherit the run", async () => {
    const child = await startChild();

    await child.start();

    assert.equal(process.env.PI_SUBAGENT_RUN, undefined);
    assert.equal(process.env.PI_SUBAGENT_NAME, undefined);
    assert.equal(process.env.PI_SUBAGENT_DEPTH, "1");
  });

  test("a nested Pi that inherited the run leaves it to the Pi that claimed it", async () => {
    const child = await startChild({ claimedElsewhere: true });

    await child.start();
    await child.emit("agent_settled", { type: "agent_settled", aborted: false }, child.ctx);

    assert.deepEqual(child.sent, []);
    assert.deepEqual(
      await child.emit("input", { type: "input", text: "hello", source: "interactive" }, child.ctx),
      { action: "continue" },
    );
    assert.equal(await child.hasOutcome(), false);
    assert.equal(child.shutdowns(), 0);
  });

  test("a task Pi never starts fails the run with the reason", async () => {
    const child = await startChild({ options: { taskStartTimeout: "50 millis" } });

    await child.start();
    await eventually(() => child.shutdowns() === 1, "the run ends");

    const outcome = await child.outcome();

    assert.equal(outcome.kind, "failed");
    assert.match(outcome.kind === "failed" ? outcome.reason : "", /did not start the task/);
  });

  test("no model fails the run before anything is sent, as pi --print exits 1", async () => {
    const child = await startChild({ withoutModel: true });

    await child.start();
    await eventually(() => child.shutdowns() === 1, "the run ends");

    assert.deepEqual(child.sent, []);
    assert.equal((await child.outcome()).kind, "failed");
  });

  test("the dismissal key cancels only an open dialog, and a dialog that stays open fails the run", async () => {
    const child = await startChild({
      options: { taskStartTimeout: "200 millis", dialogCancelTimeout: "100 millis" },
    });

    await child.start();
    await child.emit(
      "ui_prompt_start",
      { type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" },
      child.ctx,
    );

    assert.deepEqual(child.type(F12), { data: ESCAPE });

    await eventually(() => child.shutdowns() === 1, "a dialog nobody can close ends the run");

    const outcome = await child.outcome();

    assert.match(outcome.kind === "failed" ? outcome.reason : "", /custom dialog/);

    await child.emit(
      "ui_prompt_end",
      { type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
      child.ctx,
    );

    assert.deepEqual(child.type(F12), { consume: true }, "a late key never reaches the editor");
  });
});
