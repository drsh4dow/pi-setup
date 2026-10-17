import {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Config, ConfigProvider, Duration, Effect, FileSystem, Option, Schema } from "effect";
import { herdr, platform } from "./herdr.ts";
import { RunOutcome, runFiles, treeLabel } from "./launch.ts";

const READ_ONLY_NOTICE = "Read-only subagent. Steer it from its parent.";

const SOURCE = "pi:subagent";

const DISMISS_KEY = "f12";

const ESCAPE = "\u001b";

function escapeOnlyWhileDialogOpen(dialogOpen: boolean) {
  return dialogOpen ? { data: ESCAPE } : { consume: true };
}

type AgentMessage = AgentEndEvent["messages"][number];

type AssistantReply = Extract<AgentMessage, { role: "assistant" }>;

type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "claimedElsewhere" }
  | { readonly kind: "awaitingDelivery" }
  | { readonly kind: "awaitingStart" }
  | { readonly kind: "running"; readonly messages: readonly AgentMessage[] }
  | { readonly kind: "settled" };

export interface SubagentChildOptions {
  readonly taskStartTimeout?: Duration.Input;
  readonly dialogCancelTimeout?: Duration.Input;
}

const subagentRun = Config.all({
  directory: Config.String("PI_SUBAGENT_RUN").pipe(Config.option),
  name: Config.String("PI_SUBAGENT_NAME").pipe(Config.withDefault("subagent")),
  depth: Config.Int("PI_SUBAGENT_DEPTH").pipe(Config.withDefault(1)),
  pane: Config.String("HERDR_PANE_ID").pipe(Config.option),
});

const encodeOutcome = Schema.encodeEffect(Schema.fromJsonString(RunOutcome));

function printedText(reply: AssistantReply): string {
  return reply.content.flatMap((part) => (part.type === "text" ? [`${part.text}\n`] : [])).join("");
}

function latestAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role !== "assistant") continue;

    const text = printedText(message);

    if (text !== "") return text;
  }

  return "";
}

function printModeOutcome(aborted: boolean, messages: readonly AgentMessage[]): RunOutcome {
  if (aborted) return { kind: "aborted", report: latestAssistantText(messages) };

  const last = messages.at(-1);

  if (last?.role !== "assistant") return { kind: "completed", report: "" };

  if (last.stopReason === "error" || last.stopReason === "aborted") {
    const reason =
      last.errorMessage === undefined || last.errorMessage === ""
        ? `Request ${last.stopReason}`
        : last.errorMessage;

    return { kind: "failed", reason };
  }

  if (last.stopReason === "length") return { kind: "truncated", report: printedText(last) };

  return { kind: "completed", report: printedText(last) };
}

function unstartedReason(ctx: ExtensionContext, waited: Duration.Duration): string {
  const model = ctx.model;

  if (model !== undefined && !ctx.modelRegistry.getProviderAuthStatus(model.provider).configured) {
    return `Pi did not start the task: no API key or login for provider "${model.provider}".`;
  }

  return `Pi did not start the task within ${Duration.format(waited)}; it rejected the prompt.`;
}

function stopChildrenInheritingRun() {
  // oxlint-disable-next-line effecttsgo/process-env -- The scrub must reach process.env itself.
  delete process.env.PI_SUBAGENT_RUN;
  // oxlint-disable-next-line effecttsgo/process-env -- The scrub must reach process.env itself.
  delete process.env.PI_SUBAGENT_NAME;
}

export default function subagentChild(pi: ExtensionAPI, options: SubagentChildOptions = {}) {
  // Effect's default provider keeps the environment it saw first; this reads it as it is at load.
  const run = Effect.runSync(subagentRun.parse(ConfigProvider.fromEnv()));

  if (Option.isNone(run.directory)) return;

  const files = runFiles(run.directory.value);
  const label = treeLabel(run.depth, run.name);
  const taskStartTimeout = Duration.fromInputUnsafe(options.taskStartTimeout ?? "30 seconds");
  const dialogCancelTimeout = Duration.fromInputUnsafe(options.dialogCancelTimeout ?? "5 seconds");
  let phase: Phase = { kind: "starting" };
  let openDialog: number | undefined;
  let dialogsOpened = 0;
  let inputLocked = false;

  const governs = () => phase.kind !== "claimedElsewhere" && phase.kind !== "settled";

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

  const claimRun = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.writeFileString(files.claim, String(process.pid), { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    );
  });

  const lockInput = (ctx: ExtensionContext) => {
    if (inputLocked) return;

    inputLocked = true;
    ctx.ui.onTerminalInput((data) => {
      if (matchesKey(data, DISMISS_KEY)) return escapeOnlyWhileDialogOpen(openDialog !== undefined);

      if (matchesKey(data, "escape")) return undefined;

      if (matchesKey(data, "enter")) ctx.ui.notify(READ_ONLY_NOTICE, "warning");

      return { consume: true };
    });
  };

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

  const watchStart = Effect.fn("subagent.watchStart")(function* (ctx: ExtensionContext) {
    // A busy session may still run the task as a follow-up, so only an idle one has rejected it.
    yield* Effect.sleep(taskStartTimeout).pipe(
      Effect.repeat({ until: () => phase.kind !== "awaitingStart" || ctx.isIdle() }),
    );

    if (phase.kind === "awaitingStart") {
      yield* settle(ctx, { kind: "failed", reason: unstartedReason(ctx, taskStartTimeout) });
    }
  });

  const deliverTask = Effect.fn("subagent.deliverTask")(function* (ctx: ExtensionContext) {
    const fs = yield* FileSystem.FileSystem;

    const [, task] = yield* Effect.all(
      [
        reportLabel.pipe(
          Effect.catch((error) =>
            Effect.sync(() => ctx.ui.notify(`Herdr label failed: ${error.message}`, "warning")),
          ),
        ),
        fs.readFileString(files.task).pipe(Effect.option),
      ],
      { concurrency: "unbounded" },
    );

    if (Option.isNone(task)) {
      return yield* settle(ctx, { kind: "failed", reason: `Could not read ${files.task}.` });
    }

    if (ctx.model === undefined) {
      return yield* settle(ctx, {
        kind: "failed",
        reason:
          "No model is available. Pass --model, or set up a provider with an API key or /login.",
      });
    }

    phase = { kind: "awaitingStart" };
    pi.sendUserMessage(task.value, { expandPromptTemplates: true, deliverAs: "followUp" });

    return yield* watchStart(ctx);
  });

  const dismissDialog = Effect.fn("subagent.dismissDialog")(function* (
    ctx: ExtensionContext,
    dialog: number,
    kind: string,
  ) {
    if (Option.isSome(run.pane)) {
      yield* herdr(["pane", "send-keys", run.pane.value, DISMISS_KEY]).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            ctx.ui.notify(`Could not cancel the dialog: ${error.message}`, "error"),
          ),
        ),
      );
    }

    yield* Effect.sleep(dialogCancelTimeout);

    if (openDialog === dialog && governs()) {
      yield* settle(ctx, {
        kind: "failed",
        reason: `An extension opened a ${kind} dialog that stayed open after cancellation. Nobody can answer a subagent's dialogs.`,
      });
    }
  });

  // Print mode never asks about project trust. It takes the stored decision, then
  // defaultProjectTrust, then untrusted. The child answers only where Pi would ask.
  pi.on("project_trust", (event) => {
    const agentDir = getAgentDir();
    const stored = new ProjectTrustStore(agentDir).get(event.cwd);
    const policy = SettingsManager.create(event.cwd, agentDir).getDefaultProjectTrust();

    if (stored !== null || policy !== "ask") return { trusted: "undecided" };

    return { trusted: "no" };
  });

  pi.on("session_start", (_event, ctx) => {
    if (phase.kind !== "starting") return undefined;

    return Effect.runPromise(
      claimRun.pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            ctx.ui.notify(`Could not claim the run: ${error.message}`, "error"),
          ).pipe(Effect.as(false)),
        ),
        Effect.provide(platform),
        Effect.map((claimed) => {
          if (!claimed) {
            phase = { kind: "claimedElsewhere" };

            return;
          }

          stopChildrenInheritingRun();
          phase = { kind: "awaitingDelivery" };
          lockInput(ctx);
        }),
      ),
    );
  });

  // Pi emits this once every session_start handler has finished. herdr-agent-state creates its
  // reporter in its own session_start handler, and a run that starts before it stays `idle` in herdr.
  pi.on("resources_discover", (_event, ctx) => {
    if (phase.kind === "awaitingDelivery")
      Effect.runFork(deliverTask(ctx).pipe(Effect.provide(platform)));

    return undefined;
  });

  pi.on("input", (event, ctx) => {
    if (!governs() || event.source === "extension") return { action: "continue" };

    ctx.ui.notify(READ_ONLY_NOTICE, "warning");

    return { action: "handled" };
  });

  // Interactive mode skips a command whose handler throws. A result would land in the model's context.
  pi.on("user_bash", () => {
    if (governs()) throw new Error(READ_ONLY_NOTICE);

    return undefined;
  });

  pi.on("session_before_switch", () => (governs() ? { cancel: true } : undefined));
  pi.on("session_before_fork", () => (governs() ? { cancel: true } : undefined));
  pi.on("session_before_tree", () => (governs() ? { cancel: true } : undefined));
  pi.on("session_before_compact", (event) =>
    governs() && event.reason === "manual" ? { cancel: true } : undefined,
  );

  pi.on("agent_start", () => {
    if (phase.kind === "awaitingStart") phase = { kind: "running", messages: [] };
  });

  pi.on("agent_end", (event) => {
    if (phase.kind !== "awaitingStart" && phase.kind !== "running") return;

    if (event.messages.length > 0) phase = { kind: "running", messages: event.messages };
  });

  pi.on("agent_settled", (event, ctx) => {
    if (phase.kind !== "running") return undefined;

    return Effect.runPromise(
      settle(ctx, printModeOutcome(event.aborted, phase.messages)).pipe(Effect.provide(platform)),
    );
  });

  // Print mode answers every dialog at once with its cancel value. Escape is the cancel key of
  // every built-in dialog, and no extension API answers another extension's dialog in the TUI.
  pi.on("ui_prompt_start", (event, ctx) => {
    if (!governs()) return;

    dialogsOpened += 1;
    openDialog = dialogsOpened;
    lockInput(ctx);
    ctx.ui.notify(
      `Cancelled a ${event.kind} dialog: nobody answers a subagent's dialogs.`,
      "warning",
    );
    Effect.runFork(dismissDialog(ctx, openDialog, event.kind).pipe(Effect.provide(platform)));
  });

  pi.on("ui_prompt_end", () => {
    openDialog = undefined;
  });
}
