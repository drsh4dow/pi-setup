import {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  Config,
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schema,
} from "effect";
import { closeAbandonedPanes, herdr, platform } from "./herdr.ts";
import { ChildResult, herdrCaller, type RunOutcome, runFiles } from "./launch.ts";

const READ_ONLY_NOTICE = "Read-only subagent. Steer it from its parent.";

const DISMISS_KEY = "f12";

const ESCAPE = "\u001b";

const SETTLE_COMMAND = "subagent-settle";

const RESOURCE_INSTALL_TIMEOUT = "10 seconds";

function escapeOnlyWhileDialogOpen(dialogOpen: boolean) {
  return dialogOpen ? { data: ESCAPE } : { consume: true };
}

type AgentMessage = AgentEndEvent["messages"][number];

type AssistantReply = Extract<AgentMessage, { role: "assistant" }>;

type Phase =
  | { readonly kind: "starting" }
  | { readonly kind: "claimedElsewhere" }
  | { readonly kind: "claimFailed" }
  | { readonly kind: "awaitingDelivery" }
  | { readonly kind: "awaitingStart" }
  | { readonly kind: "running" }
  | { readonly kind: "settling"; readonly aborted: boolean }
  | { readonly kind: "settled" };

export interface SubagentChildOptions {
  readonly taskStartTimeout?: Duration.Input;
  readonly dialogCancelTimeout?: Duration.Input;
}

const subagentRun = Config.all({
  directory: Config.String("PI_SUBAGENT_RUN").pipe(Config.option),
  pane: Config.String("HERDR_PANE_ID").pipe(Config.option),
});

const herdrSession = Config.all({
  HERDR_ENV: Config.String("HERDR_ENV").pipe(Config.withDefault("")),
  HERDR_SOCKET_PATH: Config.String("HERDR_SOCKET_PATH").pipe(Config.withDefault("")),
  HERDR_PANE_ID: Config.String("HERDR_PANE_ID").pipe(Config.withDefault("")),
});

const encodeResult = Schema.encodeEffect(Schema.fromJsonString(ChildResult));

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

function firstToken(task: string): string {
  const space = task.search(/\s/);

  return space === -1 ? task : task.slice(0, space);
}

/**
 * The TUI shows these failures only in its pane and runs an extension command with a TUI context,
 * so `pi --print` must run such a task. An extension error mid-run still shows only in the pane,
 * because Pi hands extension errors to the TUI's error view and no extension event carries them.
 */
function printOnlyTaskReason(
  ctx: ExtensionContext,
  commands: ReturnType<ExtensionAPI["getCommands"]>,
  task: string,
): string | undefined {
  const model = ctx.model;

  if (model === undefined) return "no model is available";

  if (!ctx.modelRegistry.getProviderAuthStatus(model.provider).configured) {
    return `provider "${model.provider}" has no API key or login`;
  }

  if (ctx.modelRegistry.find(model.provider, model.id) === undefined) {
    return `model "${model.provider}/${model.id}" is not in Pi's model catalog`;
  }

  const token = firstToken(task);

  if (
    token.startsWith("/") &&
    commands.some((command) => command.source === "extension" && `/${command.name}` === token)
  ) {
    return `the task starts with the extension command ${token}`;
  }

  return undefined;
}

function stopChildrenInheritingRun() {
  // oxlint-disable-next-line effecttsgo/process-env -- The scrub must reach process.env itself.
  delete process.env.PI_SUBAGENT_RUN;
}

function sweepFinishedRunPanes(pi: ExtensionAPI) {
  const session = Effect.runSync(herdrSession.parse(ConfigProvider.fromEnv()));

  if (Option.isNone(herdrCaller(session))) return;

  pi.on("session_start", () => {
    Effect.runFork(closeAbandonedPanes().pipe(Effect.ignore, Effect.provide(platform)));
  });
}

export default function subagentChild(pi: ExtensionAPI, options: SubagentChildOptions = {}) {
  // Effect's default provider keeps the environment it saw first; this reads it as it is at load.
  const run = Effect.runSync(subagentRun.parse(ConfigProvider.fromEnv()));

  if (Option.isNone(run.directory)) return sweepFinishedRunPanes(pi);

  const files = runFiles(run.directory.value);
  const taskStartTimeout = Duration.fromInputUnsafe(options.taskStartTimeout ?? "30 seconds");
  const dialogCancelTimeout = Duration.fromInputUnsafe(options.dialogCancelTimeout ?? "5 seconds");
  const resourcesInstalled = Deferred.makeUnsafe<void>();
  let phase: Phase = { kind: "starting" };
  let openDialog: number | undefined;
  let dialogsOpened = 0;
  let inputLocked = false;

  const governs = () =>
    phase.kind !== "claimedElsewhere" && phase.kind !== "claimFailed" && phase.kind !== "settled";

  const finish = Effect.fn("subagent.finish")(function* (
    ctx: ExtensionContext,
    result: ChildResult,
  ) {
    phase = { kind: "settled" };

    const fs = yield* FileSystem.FileSystem;

    yield* encodeResult(result).pipe(
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

  // Pi asks about project trust before session_start, so whichever comes first claims the run.
  const claimOnce = Effect.suspend(() => {
    if (phase.kind !== "starting") return Effect.void;

    return claimRun.pipe(
      Effect.map((claimed) => {
        phase = claimed ? { kind: "awaitingDelivery" } : { kind: "claimedElsewhere" };
      }),
      Effect.tapError(() =>
        Effect.sync(() => {
          phase = { kind: "claimFailed" };
        }),
      ),
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

  const watchStart = Effect.fn("subagent.watchStart")(function* (ctx: ExtensionContext) {
    // A busy session may still run the task as a follow-up, so only an idle one has rejected it.
    yield* Effect.sleep(taskStartTimeout).pipe(
      Effect.repeat({ until: () => phase.kind !== "awaitingStart" || ctx.isIdle() }),
    );

    if (phase.kind === "awaitingStart") {
      yield* finish(ctx, {
        kind: "failed",
        reason: `Pi did not start the task within ${Duration.format(taskStartTimeout)}; it rejected the prompt.`,
      });
    }
  });

  const deliverTask = Effect.fn("subagent.deliverTask")(function* (ctx: ExtensionContext) {
    const fs = yield* FileSystem.FileSystem;

    // Print mode submits only after resource discovery has installed every skill and prompt.
    yield* Deferred.await(resourcesInstalled).pipe(Effect.timeoutOption(RESOURCE_INSTALL_TIMEOUT));

    const task = yield* fs.readFileString(files.task).pipe(Effect.option);

    if (Option.isNone(task)) {
      return yield* finish(ctx, { kind: "failed", reason: `Could not read ${files.task}.` });
    }

    const printOnly = printOnlyTaskReason(ctx, pi.getCommands(), task.value);

    if (printOnly !== undefined)
      return yield* finish(ctx, { kind: "printInstead", reason: printOnly });

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
      yield* finish(ctx, {
        kind: "failed",
        reason: `An extension opened a ${kind} dialog that stayed open after cancellation. Nobody can answer a subagent's dialogs.`,
      });
    }
  });

  // Print mode never asks about project trust. It takes the stored decision, then
  // defaultProjectTrust, then untrusted. The child answers only where Pi would ask.
  pi.on("project_trust", (event) =>
    Effect.runPromise(
      claimOnce.pipe(
        Effect.ignore,
        Effect.provide(platform),
        Effect.map(() => {
          if (!governs()) return { trusted: "undecided" } as const;

          const agentDir = getAgentDir();
          const stored = new ProjectTrustStore(agentDir).get(event.cwd);
          const policy = SettingsManager.create(event.cwd, agentDir).getDefaultProjectTrust();

          if (stored !== null || policy !== "ask") return { trusted: "undecided" } as const;

          return { trusted: "no" } as const;
        }),
      ),
    ),
  );

  pi.on("session_start", (_event, ctx) => {
    if (phase.kind !== "starting" && phase.kind !== "awaitingDelivery") return undefined;

    return Effect.runPromise(
      claimOnce.pipe(
        Effect.catch((error) =>
          Effect.sync(() => ctx.ui.notify(`Could not claim the run: ${error.message}`, "error")),
        ),
        Effect.provide(platform),
        Effect.map(() => {
          if (phase.kind !== "awaitingDelivery") return;

          stopChildrenInheritingRun();
          lockInput(ctx);
        }),
      ),
    );
  });

  // Pi installs discovered skills and prompts after every resources_discover handler returns, and
  // then rebuilds the editor's autocomplete chain. That rebuild is the first call of this provider
  // after its registration, and the only signal an extension gets that discovery has finished.
  pi.on("resources_discover", (_event, ctx) => {
    if (phase.kind !== "awaitingDelivery") return undefined;

    let registering = true;
    ctx.ui.addAutocompleteProvider((provider) => {
      if (!registering) Deferred.doneUnsafe(resourcesInstalled, Effect.void);

      return provider;
    });
    registering = false;

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
    if (phase.kind === "awaitingStart" || phase.kind === "settling") phase = { kind: "running" };
  });

  // Pi runs prompts that agent_settled handlers send only after every handler returns, so the
  // report queues behind them as one more deferred prompt.
  pi.on("agent_settled", (event) => {
    if (phase.kind !== "running") return;

    phase = { kind: "settling", aborted: event.aborted };
    pi.sendUserMessage(`/${SETTLE_COMMAND}`, { expandPromptTemplates: true });
  });

  pi.registerCommand(SETTLE_COMMAND, {
    description: "Writes this subagent's report once Pi has run every deferred prompt",
    handler: (_args, ctx) => {
      if (phase.kind !== "settling") return Promise.resolve();

      // Print mode reads the session's final state, which agent_before_settle can still change.
      const outcome = printModeOutcome(
        phase.aborted,
        ctx.sessionManager.buildSessionProjection().messages,
      );

      return Effect.runPromise(finish(ctx, outcome).pipe(Effect.provide(platform)));
    },
  });

  // Print mode answers every dialog at once with its cancel value. Escape is the cancel key of
  // every built-in dialog, and no extension API answers another extension's dialog in the TUI.
  // A custom() dialog differs, because its factory runs here, which print mode never does, and it
  // can resolve with its own value instead of undefined.
  pi.on("ui_prompt_start", (event, ctx) => {
    if (!governs()) return;

    dialogsOpened += 1;
    openDialog = dialogsOpened;
    lockInput(ctx);
    ctx.ui.notify(
      `Cancelling a ${event.kind} dialog: nobody answers a subagent's dialogs.`,
      "warning",
    );
    Effect.runFork(dismissDialog(ctx, openDialog, event.kind).pipe(Effect.provide(platform)));
  });

  pi.on("ui_prompt_end", () => {
    openDialog = undefined;
  });
}
