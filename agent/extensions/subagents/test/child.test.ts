import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, suite, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentEndEvent,
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { Schema } from "effect";
import extension, { type SubagentChildOptions } from "../index.ts";
import { ChildResult, runFlag } from "../launch.ts";
import { extensionTestAdapter, unsafeFixture } from "../../test/adapter.ts";

type AgentMessage = AgentEndEvent["messages"][number];

const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(ChildResult));

const decodeText = Schema.decodeUnknownSync(Schema.String);

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
  readonly task?: string;
  readonly withoutModel?: boolean;
  readonly withoutAuth?: boolean;
  readonly uncataloguedModel?: boolean;
  readonly descendant?: boolean;
}

const baseProvider = unsafeFixture<AutocompleteProvider>({});

async function startChild({
  options = { taskStartTimeout: "200 millis" },
  task = TASK,
  withoutModel = false,
  withoutAuth = false,
  uncataloguedModel = false,
  descendant = false,
}: ChildFixture = {}) {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
  const outcomeFile = path.join(runDirectory, "outcome.json");

  runDirectories.push(runDirectory);
  await writeFile(path.join(runDirectory, "task.md"), task);

  const argv = descendant ? ["node", "pi"] : ["node", "pi", runFlag(runDirectory)];

  Object.assign(process.env, {
    PI_SUBAGENT_RUN: runDirectory,
    PI_SUBAGENT_DEPTH: "1",
  });

  const adapter = extensionTestAdapter();
  const sent: string[] = [];
  const notices: string[] = [];
  const terminalInput: TerminalInputHandler[] = [];
  const autocompleteWrappers: AutocompleteProviderFactory[] = [];
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  let sessionMessages: AgentMessage[] = [];
  let shutdowns = 0;

  extension(
    {
      ...adapter.api,
      registerFlag() {},
      sendUserMessage(content) {
        sent.push(decodeText(content));
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      getCommands: () => [
        ...[...commands.keys()].map((name) =>
          unsafeFixture<ReturnType<ExtensionAPI["getCommands"]>[number]>({
            name,
            source: "extension",
          }),
        ),
        unsafeFixture<ReturnType<ExtensionAPI["getCommands"]>[number]>({
          name: "ps",
          source: "extension",
        }),
        unsafeFixture<ReturnType<ExtensionAPI["getCommands"]>[number]>({
          name: "skill:review",
          source: "skill",
        }),
      ],
    },
    { ...options, argv },
  );

  const rebuildAutocomplete = () => {
    for (const wrap of autocompleteWrappers) wrap(baseProvider);
  };

  const ctx = unsafeFixture<ExtensionCommandContext>({
    mode: "tui",
    model: withoutModel
      ? undefined
      : unsafeFixture<NonNullable<ExtensionContext["model"]>>({
          provider: "anthropic",
          id: "claude-haiku-5-5",
        }),
    modelRegistry: unsafeFixture<ExtensionContext["modelRegistry"]>({
      getProviderAuthStatus: () => unsafeFixture({ configured: !withoutAuth }),
      find: (provider, id) =>
        uncataloguedModel
          ? undefined
          : unsafeFixture<NonNullable<ExtensionContext["model"]>>({ provider, id }),
    }),
    sessionManager: unsafeFixture<ExtensionContext["sessionManager"]>({
      buildSessionProjection: () =>
        unsafeFixture<ReturnType<ExtensionContext["sessionManager"]["buildSessionProjection"]>>({
          messages: sessionMessages,
        }),
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
      addAutocompleteProvider(wrap) {
        autocompleteWrappers.push(wrap);
        rebuildAutocomplete();
      },
    }),
    shutdown() {
      shutdowns += 1;
    },
  });

  const runDeferredPrompts = async () => {
    const prompts = sent.splice(0);

    for (const prompt of prompts) {
      const command = commands.get(prompt.slice(1));

      assert.ok(command, `${prompt} is a registered command`);
      // oxlint-disable-next-line no-await-in-loop -- Pi runs deferred prompts one at a time.
      await command.handler("", ctx);
    }
  };

  return {
    ctx,
    emit: adapter.emit,
    notices,
    runDirectory,
    sent,
    filtersTerminalInput: () => terminalInput.length > 0,
    shutdowns: () => shutdowns,
    type: (data: string) => {
      const [handler] = terminalInput;
      assert.ok(handler, "the child filters terminal input");

      return handler(data);
    },
    discover: () =>
      adapter.emit(
        "resources_discover",
        { type: "resources_discover", cwd: runDirectory, reason: "startup" },
        ctx,
      ),
    rebuildAutocomplete,
    setSessionMessages(messages: AgentMessage[]) {
      sessionMessages = messages;
    },
    async settle(aborted: boolean) {
      await adapter.emit("agent_settled", { type: "agent_settled", aborted }, ctx);
      await runDeferredPrompts();
    },
    async start() {
      await adapter.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
      await adapter.emit(
        "resources_discover",
        { type: "resources_discover", cwd: runDirectory, reason: "startup" },
        ctx,
      );
      rebuildAutocomplete();
    },
    async run() {
      await this.start();
      await eventually(() => sent.length === 1, "the task is delivered");
      assert.deepEqual(sent.splice(0), [task]);
      await adapter.emit("agent_start", { type: "agent_start" }, ctx);
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

    await child.run();
    child.setSessionMessages([
      assistant(
        [
          { type: "thinking", thinking: "planning" },
          { type: "text", text: "ALPHA DONE" },
        ],
        "stop",
      ),
    ]);
    await child.settle(false);

    assert.deepEqual(await child.outcome(), { kind: "completed", report: "ALPHA DONE\n" });
    assert.equal(child.shutdowns(), 1);
  });

  test("the report is the session's final state after deferred prompts, not the run's last reply", async () => {
    const child = await startChild();

    await child.run();
    child.setSessionMessages([assistant([{ type: "text", text: "FIRST" }], "stop")]);
    await child.emit("agent_settled", { type: "agent_settled", aborted: false }, child.ctx);

    assert.equal(
      await child.hasOutcome(),
      false,
      "nothing is reported while deferred prompts wait",
    );

    await child.emit("agent_start", { type: "agent_start" }, child.ctx);
    child.setSessionMessages([
      assistant([{ type: "text", text: "FIRST" }], "stop"),
      assistant([{ type: "text", text: "FOLLOW-UP" }], "stop"),
    ]);
    await child.settle(false);

    assert.deepEqual(await child.outcome(), { kind: "completed", report: "FOLLOW-UP\n" });
    assert.equal(child.shutdowns(), 1);
  });

  test("a reply cut at the token limit keeps its text and fails, as in print mode", async () => {
    const child = await startChild();

    await child.run();
    child.setSessionMessages([assistant([{ type: "text", text: "PARTIAL" }], "length")]);
    await child.settle(false);

    assert.deepEqual(await child.outcome(), { kind: "truncated", report: "PARTIAL\n" });
  });

  test("an aborted run reports the latest text, which precedes the aborted tool call", async () => {
    const child = await startChild();

    await child.run();
    child.setSessionMessages([
      assistant([{ type: "text", text: "STARTING" }], "toolUse"),
      assistant([], "aborted"),
    ]);
    await child.settle(true);

    assert.deepEqual(await child.outcome(), { kind: "aborted", report: "STARTING\n" });
    assert.equal(child.shutdowns(), 1);
  });

  test("delivers the task only after Pi installs the discovered skills and prompts", async () => {
    const child = await startChild();

    await child.emit("session_start", { type: "session_start", reason: "startup" }, child.ctx);
    await child.discover();
    await delay(50);

    assert.deepEqual(child.sent, [], "discovery handlers may still be running");

    child.rebuildAutocomplete();
    await eventually(() => child.sent.length === 1, "the task is delivered");
  });

  for (const [name, fixture, reason] of [
    ["an extension command", { task: "/ps --all" }, /extension command \/ps/],
    ["no model", { withoutModel: true }, /no model/],
    ["a provider without credentials", { withoutAuth: true }, /no API key or login/],
    ["a model outside the catalog", { uncataloguedModel: true }, /not in Pi's model catalog/],
  ] as const) {
    test(`hands ${name} back to pi --print before sending anything`, async () => {
      const child = await startChild(fixture);

      await child.start();
      await eventually(() => child.shutdowns() === 1, "the run ends");

      const outcome = await child.outcome();

      assert.deepEqual(child.sent, []);
      assert.equal(outcome.kind, "printInstead");
      assert.match(outcome.kind === "printInstead" ? outcome.reason : "", reason);
    });
  }

  test("answers project trust only while it holds the run", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-"));
    runDirectories.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const claimed = await startChild();
    const event = { type: "project_trust", cwd: agentDir } as const;

    assert.deepEqual(await claimed.emit("project_trust", event, claimed.ctx), { trusted: "no" });

    const descendant = await startChild({ descendant: true });

    assert.deepEqual(await descendant.emit("project_trust", event, descendant.ctx), {
      trusted: "undecided",
    });
  });

  test("a Pi that cannot claim the run answers no trust prompt and locks no input", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-"));
    runDirectories.push(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const child = await startChild();

    await rm(child.runDirectory, { recursive: true, force: true });

    assert.deepEqual(
      await child.emit("project_trust", { type: "project_trust", cwd: agentDir }, child.ctx),
      { trusted: "undecided" },
    );

    await child.start();

    assert.equal(child.filtersTerminalInput(), false, "typed keys reach Pi");
    assert.deepEqual(
      await child.emit("input", { type: "input", text: "hello", source: "interactive" }, child.ctx),
      { action: "continue" },
    );
    assert.deepEqual(child.sent, []);
  });

  test("processes the child starts do not inherit the run", async () => {
    const child = await startChild();

    await child.start();

    assert.equal(process.env.PI_SUBAGENT_RUN, undefined);
    assert.equal(process.env.PI_SUBAGENT_DEPTH, "1");
  });

  test("a descendant Pi that inherited the run leaves it to pi", async () => {
    const child = await startChild({ descendant: true });

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
