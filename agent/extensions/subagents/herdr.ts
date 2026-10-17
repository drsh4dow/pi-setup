import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Data, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { isRunDirectory, PaneListResponse } from "./launch.ts";

export const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  ),
);

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message(): string {
    return `herdr ${this.args.join(" ")} exited with ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

export const herdr = Effect.fn("herdr")(
  function* (args: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make("herdr", args));

    const [exitCode, stdout, stderr] = yield* Effect.all(
      [
        handle.exitCode,
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );

    if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new HerdrError({ args, exitCode, stderr });
    }

    return stdout;
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
);

const decodePaneList = Schema.decodeUnknownEffect(Schema.fromJsonString(PaneListResponse));

/**
 * Herdr saves a session before it hangs up its panes, so a subagent pane open at `herdr session
 * stop` comes back on restart in a directory its launcher has since removed.
 */
export const closeAbandonedPanes = Effect.fn("closeAbandonedPanes")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const listed = yield* herdr(["pane", "list"]).pipe(Effect.flatMap(decodePaneList));

  const abandoned = yield* Effect.filter(
    listed.result.panes.filter((pane) => isRunDirectory(pane.cwd)),
    (pane) => fs.exists(pane.cwd).pipe(Effect.map((exists) => !exists)),
  );

  yield* Effect.forEach(abandoned, (pane) => herdr(["pane", "close", pane.pane_id]));

  return abandoned.map((pane) => pane.pane_id);
});
