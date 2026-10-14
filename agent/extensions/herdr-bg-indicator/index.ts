import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Clock, Config, Data, Effect, Fiber, Layer, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { observeProcessStatusRefresh, processStatusSummary } from "../process-status/status.ts";

// The Herdr sidebar renders this pane token wherever its config names `$bg`.
const TOKEN = "bg";

const SOURCE = "pi:bg-terminals";

// The heartbeat renews the token well before it expires, so the marker disappears
// within TTL_MS when Pi dies without clearing it.
const TTL_MS = 30_000;

const HEARTBEAT = "10 seconds";

const spawnerLayer = BunChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);

const herdrPane = Config.all({
  enabled: Config.String("HERDR_ENV").pipe(Config.withDefault("")),
  paneId: Config.String("HERDR_PANE_ID").pipe(Config.withDefault("")),
});

class MetadataReportError extends Data.TaggedError("MetadataReportError")<{
  paneId: string;
  exitCode: number;
  stderr: string;
}> {
  override get message(): string {
    return `herdr pane report-metadata ${this.paneId} exited with ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

function metadataReporter(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  paneId: string,
) {
  // Herdr ignores a sequence at or below the last one it accepted from this source for the
  // pane's lifetime, so a Pi restarted in the same pane must not count from zero.
  let seq = Effect.runSync(Clock.currentTimeMillis) * 1000;

  return Effect.fn("herdr.reportMetadata")(
    function* (fields: readonly string[]) {
      seq += 1;

      const command = ChildProcess.make(
        "herdr",
        ["pane", "report-metadata", paneId, "--source", SOURCE, "--seq", String(seq), ...fields],
        { stdout: "ignore" },
      );

      const handle = yield* spawner.spawn(command);

      const [exitCode, stderr] = yield* Effect.all(
        [handle.exitCode, handle.stderr.pipe(Stream.decodeText(), Stream.mkString)],
        { concurrency: "unbounded" },
      );

      if (exitCode === ChildProcessSpawner.ExitCode(0)) return undefined;

      return yield* new MetadataReportError({ paneId, exitCode, stderr });
    },
    Effect.scoped,
    Effect.timeout("2 seconds"),
  );
}

type ReportMetadata = ReturnType<typeof metadataReporter>;

function createIndicator(pi: ExtensionAPI, ctx: ExtensionContext, reportMetadata: ReportMetadata) {
  // Runs exactly while Herdr may show the token.
  let heartbeat: Fiber.Fiber<unknown> | undefined;
  let clearing: Fiber.Fiber<void> | undefined;
  let failing = false;
  let stopped = false;

  // Herdr is unreachable for as long as it stays down, so only the first failure is shown.
  const send = (fields: readonly string[]) =>
    reportMetadata(fields).pipe(
      Effect.map(() => {
        failing = false;
      }),
      Effect.catch((error) =>
        Effect.sync(() => {
          if (failing) return;
          failing = true;
          ctx.ui.notify(`Herdr background-terminal marker failed: ${error.message}`, "warning");
        }),
      ),
    );

  const showToken = Effect.suspend(() => {
    const summary = processStatusSummary(pi);

    if (summary === undefined) return Effect.void;

    return send(["--token", `${TOKEN}=${summary}`, "--ttl-ms", String(TTL_MS)]);
  });

  const clearToken = send(["--clear-token", TOKEN]);

  return {
    refresh() {
      if (stopped) return;

      if (processStatusSummary(pi) !== undefined) {
        // A live heartbeat already shows the token; report now so a changed count appears.
        if (heartbeat) {
          Effect.runFork(showToken);

          return;
        }

        heartbeat = Effect.runFork(
          Effect.repeat(showToken, { schedule: Schedule.spaced(HEARTBEAT) }),
        );

        return;
      }

      if (!heartbeat) return;
      Effect.runFork(Fiber.interrupt(heartbeat));
      heartbeat = undefined;
      clearing = Effect.runFork(clearToken);
    },
    // Pi may exit right after shutdown, so the clear finishes before this resolves.
    stop: Effect.gen(function* () {
      stopped = true;

      if (heartbeat) {
        yield* Fiber.interrupt(heartbeat);
        heartbeat = undefined;
        yield* clearToken;

        return;
      }

      if (clearing) yield* Fiber.join(clearing);
    }),
  };
}

export default function herdrBgIndicator(pi: ExtensionAPI) {
  const pane = Effect.runSync(herdrPane);

  if (pane.enabled !== "1" || !pane.paneId) return;

  let indicator: ReturnType<typeof createIndicator> | undefined;

  observeProcessStatusRefresh(pi, () => indicator?.refresh());

  pi.on("session_start", (_event, ctx) => {
    // Subagents in print, JSON, or RPC mode inherit HERDR_PANE_ID; only the TUI owns the pane.
    if (ctx.mode !== "tui") return;

    const spawner = Effect.runSync(
      ChildProcessSpawner.ChildProcessSpawner.pipe(Effect.provide(spawnerLayer)),
    );

    indicator = createIndicator(pi, ctx, metadataReporter(spawner, pane.paneId));
    indicator.refresh();
  });
  pi.on("session_shutdown", () => {
    const stopping = indicator;
    indicator = undefined;

    return Effect.runPromise(stopping?.stop ?? Effect.void);
  });
}
