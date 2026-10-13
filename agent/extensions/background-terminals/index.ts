import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "@earendil-works/pi-ai";
import type {
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer, Path } from "effect";
import { sanitizeInline, sanitizeMultiline } from "../../lib/text.ts";
import {
  registerBackgroundTerminalStatus,
  requestProcessStatusRefresh,
} from "../process-status/status.ts";
import {
  BackgroundTerminalDelivery,
  formatTerminalReport,
  NOTIFICATION_MESSAGE,
  RESULTS_MESSAGE,
  sanitizeErrorForDisplay,
  summary,
  terminalMetadata,
  terminalMetadataSchema,
  terminalStateSchema,
} from "./delivery.ts";
import { MAX_TRACKED } from "./manager.ts";
import {
  renderKillCall,
  renderKillResult,
  renderNotificationMessage,
  renderResultsMessage,
  renderStartCall,
  renderStartResult,
  renderStatusCall,
  renderStatusResult,
  terminalView,
} from "./render.ts";
import { type BackgroundTerminalSession, joinBackgroundTerminalSession } from "./session.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

const observationSchema = Type.Union([
  Type.Literal("first"),
  Type.Literal("changed"),
  Type.Literal("unchanged"),
]);

const statusOutputSchema = Type.Object({
  ...terminalMetadataSchema.properties,
  observation: observationSchema,
  stdout: Type.String(),
  stderr: Type.String(),
});

const listOutputSchema = Type.Object({
  terminals: Type.Array(terminalMetadataSchema),
  deliveryProblem: Type.Union([Type.String(), Type.Null()]),
});

const killOutputSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      id: Type.String(),
      title: Type.String(),
      state: terminalStateSchema,
      wasRunning: Type.Boolean(),
      killed: Type.Boolean(),
    }),
  ),
});

const SETTLE_WAIT_MS = 10 * 60_000;

const MAX_IDLE_SETTLE_WAITS = 3;

// Interactive and RPC sessions outlive the turn, so completion wakes them
// later. Print and JSON runs exit when the run settles.
function sessionOutlivesRun(mode: ExtensionContext["mode"]): boolean {
  switch (mode) {
    case "tui":
    case "rpc":
      return true;
    case "print":
    case "json":
      return false;
    default: {
      const unexpected: never = mode;
      throw new Error(`Unexpected run mode: ${String(unexpected)}`);
    }
  }
}

const runningTerminals = (terminals: BackgroundTerminalSession) =>
  terminals.list().filter((terminal) => terminal.state === "running");

function stillRunningNotice(terminals: BackgroundTerminalSession): CustomMessageEntryDraft {
  return {
    type: "custom_message",
    customType: NOTIFICATION_MESSAGE,
    display: true,
    content: `[Background terminals still running]\n\n${runningTerminals(terminals).map(summary).join("\n")}\n\nThis run is non-interactive: it ends at your next message without a tool call, and shutdown kills these terminals. Stop the ones you no longer need with bg_kill. End your turn again to keep waiting for the rest.`,
  };
}

export interface BackgroundTerminalOptions {
  /** How long a print or JSON run waits at settle for a running terminal to finish. */
  settleWaitMs?: number;
}

export default function backgroundTerminals(
  pi: ExtensionAPI,
  options: BackgroundTerminalOptions = {},
) {
  const delivery = new BackgroundTerminalDelivery(pi);
  let session: BackgroundTerminalSession | undefined;
  const observations = new Map<string, object>();
  let idleSettleWaits = 0;

  const currentSession = () => {
    if (!session) throw new Error("Background terminals are unavailable before session start.");

    return session;
  };

  const updateStatus = () => requestProcessStatusRefresh(pi);

  registerBackgroundTerminalStatus(pi, {
    list: () => session?.list() ?? [],
    get: (id) => session?.get(id),
  });

  const leaveSession = Effect.fn("leaveSession")(function* () {
    const joined = session;
    session = undefined;
    observations.clear();
    updateStatus();

    if (joined) yield* joined.leave;
  });

  pi.on("session_start", (_event, ctx) => {
    delivery.setContext(ctx);

    if (!session) session = joinBackgroundTerminalSession(delivery, updateStatus);
    updateStatus();
  });
  pi.on("agent_settled", () => Effect.runPromise(delivery.flush));

  pi.on("turn_end", ({ message }) => {
    if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall"))
      idleSettleWaits = 0;
  });

  pi.on("agent_before_settle", ({ outcome }, ctx) =>
    Effect.runPromise(
      Effect.gen(function* () {
        // Captured so a shutdown during the wait cannot swap the session.
        const terminals = session;

        if (sessionOutlivesRun(ctx.mode) || outcome !== "completed" || !terminals) return undefined;

        if (runningTerminals(terminals).length === 0) return undefined;

        yield* delivery.waitForCompletion(options.settleWaitMs ?? SETTLE_WAIT_MS, ctx.signal);

        const results = delivery.takeCompletions();

        if (results) {
          idleSettleWaits = 0;

          return { entries: [results], continue: true };
        }

        idleSettleWaits++;

        if (idleSettleWaits > MAX_IDLE_SETTLE_WAITS) return undefined;

        return { entries: [stillRunningNotice(terminals)], continue: true };
      }),
    ),
  );
  pi.on("session_shutdown", () => Effect.runPromise(leaveSession()));
  pi.registerMessageRenderer(RESULTS_MESSAGE, renderResultsMessage);
  pi.registerMessageRenderer(NOTIFICATION_MESSAGE, renderNotificationMessage);

  pi.registerTool({
    name: "bg_start",
    label: "Start Background Terminal",
    description:
      "Start a non-interactive, session-scoped shell command in the background, for services, watchers, subagents, or finite commands alongside independent work. Completion automatically wakes the owning agent with the real exit code. Use emit-to-pi <message> only for meaningful intermediate events while running; it never settles the command. Only bounded output tails are retained; redirect explicitly for durable/full logs.",
    promptSnippet:
      "Start a service, watcher, subagent, or finite command alongside independent work",
    promptGuidelines: [
      "Use bg_start only for services, watchers, subagents, and finite commands that run alongside independent work.",
      "Continue genuinely independent work. If the requested answer depends on the job and nothing independent remains, give only a brief pending status and end the turn; deliver the answer after completion wakes you. Do not repeat the background task while waiting or poll for completion.",
      "Use meaningful titles and avoid duplicate servers or watchers.",
      "Run finite bg_start jobs without a notification wrapper to preserve their exit status. Success and failure automatically wake the owner with the real exit code. Use emit-to-pi only for actionable intermediate milestones, never as a completion signal or a trailing command that masks the work's exit code.",
      "Never use for interactive commands. Background commands share the worktree without write isolation; avoid overlapping mutations.",
    ],
    parameters: Type.Object({
      command: Type.String({ maxLength: 100_000 }),
      title: Type.String({ maxLength: 160 }),
      working_dir: Type.Optional(Type.String({ maxLength: 4_096 })),
    }),
    outputSchema: terminalMetadataSchema,
    executionMode: "parallel",
    renderCall: renderStartCall,
    renderResult: renderStartResult,
    execute(_id, params, _signal, _update, ctx) {
      return Effect.runPromise(
        Effect.gen(function* () {
          const command = params.command.trim();

          if (!command) throw new Error("command must not be empty.");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");

          const cwdIsDirectory = yield* fs.stat(cwd).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          );

          if (!cwdIsDirectory)
            throw new Error(`working_dir is not a directory: ${sanitizeInline(cwd)}`);

          const snapshot = yield* Effect.sync(() => {
            try {
              return currentSession().start({
                command,
                title:
                  Array.from(
                    new Intl.Segmenter().segment(sanitizeInline(params.title).trim()),
                    ({ segment }) => segment,
                  )
                    .slice(0, 80)
                    .join("") || "terminal",
                cwd,
              });
            } catch (error) {
              throw sanitizeErrorForDisplay(error instanceof Error ? error : String(error));
            }
          });

          const metadata = terminalMetadata(snapshot);

          return {
            content: [
              {
                type: "text" as const,
                text: `Started ${summary(snapshot)}\nCompletion automatically wakes you with the real exit code; no emit-to-pi is needed. Continue genuinely independent work. If the requested answer depends on this job and nothing independent remains, give only a brief pending status and end the turn; deliver the answer after completion wakes you. Do not repeat the background task while waiting or poll for completion.\nOnly the newest 256 KiB per stream is retained; redirect explicitly for durable/full logs.`,
              },
            ],
            details: metadata,
            structuredContent: metadata,
          };
        }).pipe(Effect.provide(platformLayer)),
      );
    },
  });
  pi.registerTool({
    name: "bg_status",
    label: "Background Terminal Status",
    description:
      "Inspect state and bounded stdout/stderr tails, including changes since the previous bg_status read. Use for immediate inspection, not polling.",
    parameters: Type.Object({ id: Type.String({ maxLength: 64 }) }),
    outputSchema: statusOutputSchema,
    executionMode: "parallel",
    renderCall: renderStatusCall,
    renderResult: renderStatusResult,
    execute(_id, params) {
      return Effect.runPromise(
        Effect.sync(() => {
          const terminalSession = currentSession();
          const snapshot = terminalSession.get(params.id);

          if (!snapshot) throw new Error(`Unknown terminal id "${sanitizeInline(params.id)}".`);

          if (snapshot.state !== "running") terminalSession.consume([snapshot.id]);

          const metadata = terminalMetadata(snapshot);

          const evidence = {
            ...metadata,
            process: snapshot.state === "running" ? snapshot.process : snapshot.result,
          };

          const previous = observations.get(snapshot.id);

          let observation: Static<typeof observationSchema> = "first";

          if (previous !== undefined) {
            observation = isDeepStrictEqual(previous, evidence) ? "unchanged" : "changed";
          }

          observations.delete(snapshot.id);
          observations.set(snapshot.id, evidence);

          if (observations.size > MAX_TRACKED) {
            const oldest = observations.keys().next();

            if (!oldest.done) observations.delete(oldest.value);
          }

          return {
            content: [
              {
                type: "text",
                text: `${formatTerminalReport(snapshot)}\nObservation: ${observation} since previous bg_status read. stdout=${snapshot.stdout.totalBytes} bytes stderr=${snapshot.stderr.totalBytes} bytes.${snapshot.state === "running" ? "\nCompletion or an emit-to-pi event will wake you; do not poll." : ""}`,
              },
            ],
            details: { ...metadata, observation, terminal: terminalView(snapshot) },
            structuredContent: {
              ...metadata,
              observation,
              stdout: sanitizeMultiline(snapshot.stdout.text),
              stderr: sanitizeMultiline(snapshot.stderr.text),
            } satisfies Static<typeof statusOutputSchema>,
          };
        }),
      );
    },
  });
  pi.registerTool({
    name: "bg_list",
    label: "List Background Terminals",
    description: "List session-scoped tracked background terminals without their output.",
    parameters: Type.Object({}),
    outputSchema: listOutputSchema,
    executionMode: "parallel",
    execute() {
      return Effect.runPromise(
        Effect.sync(() => {
          const entries = currentSession().list();
          const terminals = entries.map(terminalMetadata);

          const listing = entries.length
            ? entries.map(summary).join("\n")
            : "No background terminals.";

          return {
            content: [
              {
                type: "text",
                text: delivery.problem ? `${listing}\n${delivery.problem}` : listing,
              },
            ],
            details: { terminals },
            structuredContent: {
              terminals,
              deliveryProblem: delivery.problem ?? null,
            } satisfies Static<typeof listOutputSchema>,
          };
        }),
      );
    },
  });
  pi.registerTool({
    name: "bg_kill",
    label: "Kill Background Terminals",
    description: "Terminate background process trees with bounded SIGTERM-to-SIGKILL escalation.",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ maxLength: 64 }), {
        minItems: 1,
        maxItems: 16,
      }),
    }),
    outputSchema: killOutputSchema,
    executionMode: "parallel",
    renderCall: renderKillCall,
    renderResult: renderKillResult,
    execute(_id, params, signal) {
      const ids = [...new Set(params.ids)];
      const terminalSession = currentSession();
      let killError: Error | undefined;

      const work = Effect.runPromise(Effect.suspend(() => terminalSession.kill(ids)));

      work.catch((error) => {
        killError = sanitizeErrorForDisplay(error instanceof Error ? error : String(error));
      });

      return Effect.runPromise(
        Effect.promise(() => work).pipe(
          Effect.map((results) => {
            terminalSession.consume(ids);

            const outcome = {
              results: results.map(({ id, wasRunning, killed, snapshot }) => ({
                id,
                title: sanitizeInline(snapshot.title),
                state: snapshot.state,
                wasRunning,
                killed,
              })),
            };

            return {
              content: [
                {
                  type: "text" as const,
                  text: outcome.results
                    .map(
                      (result) =>
                        `${result.id} [${result.state}] ${result.title}${result.killed ? " · killed" : " · already settled"}`,
                    )
                    .join("\n"),
                },
              ],
              details: {
                ...outcome,
                terminals: results.map(({ snapshot }) => terminalView(snapshot)),
              },
              structuredContent: outcome satisfies Static<typeof killOutputSchema>,
            };
          }),
        ),
        { signal },
      ).catch((error) => {
        // An abort only interrupts the wait. A failure of the kill itself
        // must surface even when the signal is also aborted.
        if (killError) throw killError;

        if (signal?.aborted) {
          throw new Error("Kill wait aborted; termination continues in the background.");
        }

        throw sanitizeErrorForDisplay(error instanceof Error ? error : String(error));
      });
    },
  });
}
