import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Config, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { herdr } from "./herdr.ts";
import { RunOutcome, runFiles, treeLabel } from "./launch.ts";

const READ_ONLY_NOTICE = "Read-only subagent. Steer it from its parent.";

const SOURCE = "pi:subagent";

type AgentMessage = AgentEndEvent["messages"][number];

type AssistantReply = Extract<AgentMessage, { role: "assistant" }>;

/**
 * `delivering` covers the gap between `session_start` and the task's `sendUserMessage`, so a run
 * another extension starts first is not mistaken for the assignment.
 */
type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "delivering" }
  | { readonly kind: "running"; readonly messages: readonly AgentMessage[] }
  | { readonly kind: "settled" };

const subagentRun = Config.all({
  directory: Config.String("PI_SUBAGENT_RUN").pipe(Config.option),
  name: Config.String("PI_SUBAGENT_NAME").pipe(Config.withDefault("subagent")),
  depth: Config.Int("PI_SUBAGENT_DEPTH").pipe(Config.withDefault(1)),
  pane: Config.String("HERDR_PANE_ID").pipe(Config.option),
});

const fileSystem = BunFileSystem.layer;

const services = Layer.mergeAll(
  fileSystem,
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(fileSystem, BunPath.layer))),
);

const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(RunOutcome));

function lastReply(messages: readonly AgentMessage[]): AssistantReply | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "assistant") return message;
  }

  return undefined;
}

function replyText(reply: AssistantReply): string {
  return reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** An abort usually lands after a tool call, so the partial report is the latest text the model wrote. */
function partialReport(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role === "assistant" && replyText(message) !== "") return replyText(message);
  }

  return "";
}

/** Mirrors how `pi --print` turns the final assistant message into stdout and an exit code. */
function outcomeOf(aborted: boolean, messages: readonly AgentMessage[]): RunOutcome {
  if (aborted) return { kind: "aborted", report: partialReport(messages) };

  const reply = lastReply(messages);

  if (reply === undefined) {
    return { kind: "failed", reason: "The run settled without an assistant reply." };
  }

  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    return { kind: "failed", reason: reply.errorMessage ?? `Request ${reply.stopReason}` };
  }

  if (reply.stopReason === "length") {
    return {
      kind: "failed",
      reason: "Response was truncated: the model reached its output token limit.",
    };
  }

  return { kind: "completed", report: replyText(reply) };
}

export default function subagentChild(pi: ExtensionAPI) {
  const run = Effect.runSync(subagentRun);

  if (Option.isNone(run.directory)) return;

  const files = runFiles(run.directory.value);
  const label = treeLabel(run.depth, run.name);
  let phase: Phase = { kind: "starting" };
  let promptOpen = false;

  const settle = Effect.fn("subagent.settle")(function* (
    ctx: ExtensionContext,
    outcome: RunOutcome,
  ) {
    phase = { kind: "settled" };

    const fs = yield* FileSystem.FileSystem;

    yield* encodeOutcome(outcome).pipe(
      Effect.flatMap((encoded) => fs.writeFileString(files.outcome, encoded)),
      Effect.catch((error) =>
        Effect.sync(() => ctx.ui.notify(`Could not write the outcome: ${error.message}`, "error")),
      ),
    );
    yield* Effect.sync(() => ctx.shutdown());
  });

  const reportLabel = Effect.suspend(() => {
    if (Option.isNone(run.pane)) return Effect.void;

    return herdr([
      "pane",
      "report-metadata",
      run.pane.value,
      "--source",
      SOURCE,
      "--display-agent",
      label,
    ]);
  });

  const deliverTask = Effect.fn("subagent.deliverTask")(function* (ctx: ExtensionContext) {
    yield* reportLabel.pipe(
      Effect.catch((error) =>
        Effect.sync(() => ctx.ui.notify(`Herdr label failed: ${error.message}`, "warning")),
      ),
    );

    const fs = yield* FileSystem.FileSystem;

    const task = yield* fs
      .readFileString(files.task)
      .pipe(
        Effect.catch((error) =>
          settle(ctx, { kind: "failed", reason: `Could not read the task: ${error.message}` }).pipe(
            Effect.as(undefined),
          ),
        ),
      );

    if (task === undefined) return;

    phase = { kind: "running", messages: [] };
    pi.sendUserMessage(task);
  });

  const dismissPrompt = Effect.suspend(() => {
    if (!promptOpen || Option.isNone(run.pane)) return Effect.void;

    return herdr(["pane", "send-keys", run.pane.value, "esc"]);
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    ctx.ui.notify(READ_ONLY_NOTICE, "warning");

    return { action: "handled" };
  });

  pi.on("session_start", (_event, ctx) => {
    if (phase.kind !== "starting") return;

    phase = { kind: "delivering" };

    // Herdr-agent-state creates its reporter in its own session_start handler. A run that starts
    // before that handler has run stays `idle` in herdr, so the task waits for this fiber.
    Effect.runFork(deliverTask(ctx).pipe(Effect.provide(services)));
  });

  pi.on("agent_end", (event) => {
    if (phase.kind !== "running") return;

    if (event.messages.length > 0) phase = { kind: "running", messages: event.messages };
  });

  pi.on("agent_settled", (event, ctx) => {
    const settling =
      phase.kind === "running"
        ? settle(ctx, outcomeOf(event.aborted, phase.messages))
        : Effect.void;

    return Effect.runPromise(settling.pipe(Effect.provide(services)));
  });

  // Print mode answers every dialog at once with its cancel value. Escape is the cancel key of
  // every built-in dialog, so the child sends it to its own pane.
  pi.on("ui_prompt_start", (event, ctx) => {
    promptOpen = true;
    ctx.ui.notify(
      `Dismissed a ${event.kind} prompt: nobody answers a subagent's dialogs.`,
      "warning",
    );
    Effect.runFork(
      dismissPrompt.pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            ctx.ui.notify(`Could not dismiss the prompt: ${error.message}`, "error"),
          ),
        ),
        Effect.provide(services),
      ),
    );
  });

  pi.on("ui_prompt_end", () => {
    promptOpen = false;
  });
}
