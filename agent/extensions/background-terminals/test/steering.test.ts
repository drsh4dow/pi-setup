import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  type FauxResponseFactory,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import extension from "../index.ts";

const { mkdtempSync, rmSync } = process.getBuiltinModule("node:fs");

const { tmpdir } = process.getBuiltinModule("node:os");

const { join } = process.getBuiltinModule("node:path");

type ModelContext = Parameters<FauxResponseFactory>[0];

type ModelMessage = ModelContext["messages"][number];

// Busy work that outlasts the background command so the result arrives
// while a tool call is still executing.
const independentWork = () =>
  Effect.runPromise(
    Effect.sleep(500).pipe(
      Effect.as({
        content: [{ type: "text" as const, text: "independent work finished" }],
        details: {},
      }),
    ),
  );

const runFauxSession = Effect.fn("runFauxSession")(function* (
  t: TestContext,
  prompt: string,
  responses: FauxResponseStep[],
) {
  const directory = mkdtempSync(join(tmpdir(), "pi-bg-steering-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const settingsManager = SettingsManager.inMemory({
    defaultProjectTrust: "always",
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      extension,
      (pi) =>
        pi.registerTool({
          name: "independent_work",
          label: "Independent work",
          description: "Busy work that keeps the agent run busy",
          parameters: Type.Object({}),
          execute: independentWork,
        }),
    ],
  });

  yield* Effect.promise(() => loader.reload());
  assert.deepEqual(loader.getExtensions().errors, []);

  const provider = fauxProvider();

  const { session } = yield* Effect.acquireRelease(
    Effect.promise(() =>
      createAgentSession({
        cwd: directory,
        agentDir: directory,
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(directory),
        model: provider.getModel(),
        thinkingLevel: "off",
      }),
    ),
    (created) => Effect.sync(() => created.session.dispose()),
  );

  const errors: string[] = [];
  yield* Effect.promise(() =>
    session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error.error),
    }),
  );
  assert.deepEqual(errors, []);
  session.modelRuntime.registerNativeProvider(provider.provider);
  session.setActiveToolsByName(["bg_start", "bg_kill", "independent_work"]);

  provider.setResponses(responses);

  yield* Effect.promise(() => session.prompt(prompt));
  yield* Effect.promise(() => session.waitForIdle());

  return { session, provider };
});

const readByModel = (messages: readonly ModelMessage[], text: string) =>
  messages.flatMap((message, index) =>
    message.role !== "assistant" && JSON.stringify(message.content).includes(text) ? [index] : [],
  );

function recordingTextReplies(count: number) {
  const requests: ModelContext[] = [];

  const reply: FauxResponseFactory = (context) => {
    requests.push(context);

    return fauxAssistantMessage("ack");
  };

  return {
    replies: Array.from({ length: count }, () => reply),
    lastRequest: () => requests.at(-1)?.messages ?? [],
  };
}

test("a finished background command reaches the model before its next call, not after the run", (t) =>
  Effect.gen(function* () {
    let finalContext: ModelContext | undefined;

    const { session, provider } = yield* runFauxSession(
      t,
      "Start the background command, then do independent work.",
      [
        fauxAssistantMessage(
          fauxToolCall("bg_start", {
            command: "sleep 0.1; printf 'background output'; exit 23",
            title: "steering probe",
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxToolCall("independent_work", {}), {
          stopReason: "toolUse",
        }),
        (context) => {
          finalContext = context;

          return fauxAssistantMessage("ack");
        },
      ],
    );

    // Three model calls only: the run ended on its own final answer. A
    // post-run follow-up turn would need a fourth call.
    assert.equal(provider.state.callCount, 3);
    assert.equal(session.getLastAssistantText(), "ack");

    const messages = finalContext?.messages ?? [];

    const resultIndex = messages.findIndex((message) => {
      if (message.role !== "user") return false;
      const text = JSON.stringify(message.content);

      return text.includes("exit 23") && text.includes("background output");
    });

    assert.ok(resultIndex !== -1, "background result missing from the final model call");
    assert.ok(
      messages.slice(0, resultIndex).some((message) => message.role === "toolResult"),
      "background result must follow the tool results",
    );
  }).pipe(Effect.scoped, Effect.runPromise));

test("a notification from a terminal that exits during a turn reaches the model before or with its completion", (t) =>
  Effect.gen(function* () {
    const { replies, lastRequest } = recordingTextReplies(4);

    yield* runFauxSession(t, "Start the background command, then do independent work.", [
      fauxAssistantMessage(
        fauxToolCall("bg_start", {
          command: "emit-to-pi \"note-$((40+2))\"; sleep 0.1; printf 'job output'; exit 23",
          title: "exiting job",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("independent_work", {}), { stopReason: "toolUse" }),
      ...replies,
    ]);

    const notifications = readByModel(lastRequest(), "note-42");
    const completions = readByModel(lastRequest(), "exit 23");

    assert.equal(notifications.length, 1, "the model reads the notification once");
    assert.equal(completions.length, 1, "the model reads the completion once");
    assert.ok(notifications[0] <= completions[0], "the notification comes before or with the end");
  }).pipe(Effect.scoped, Effect.runPromise));

test("a notification queued during a turn reaches the model once when bg_kill ends its terminal", (t) =>
  Effect.gen(function* () {
    const { replies, lastRequest } = recordingTextReplies(4);

    const killStartedTerminal: FauxResponseFactory = (context) => {
      const started = readByModel(context.messages, "Started bt-");
      const id = JSON.stringify(context.messages[started[0]].content).match(/bt-\d+/)?.[0];
      assert.ok(id, "bg_start result names the terminal");

      return fauxAssistantMessage(fauxToolCall("bg_kill", { ids: [id] }), {
        stopReason: "toolUse",
      });
    };

    yield* runFauxSession(t, "Start the watcher, do independent work, then kill the watcher.", [
      fauxAssistantMessage(
        fauxToolCall("bg_start", {
          command: 'emit-to-pi "note-$((40+2))"; sleep 30',
          title: "watcher",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("independent_work", {}), { stopReason: "toolUse" }),
      killStartedTerminal,
      ...replies,
    ]);

    assert.equal(
      readByModel(lastRequest(), "note-42").length,
      1,
      "the model reads the notification once, in the kill result or a later message",
    );
  }).pipe(Effect.scoped, Effect.runPromise));
