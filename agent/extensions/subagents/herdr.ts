import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Data, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's FileSystem has no lstat, and its stat follows symlinks.
import { lstatSync } from "node:fs";
import {
  PaneListResponse,
  parseRunDirectoryName,
  readInteger,
  runFiles,
  type RuntimeRoot,
} from "./launch.ts";
import { isAlive } from "./process-group.ts";

export const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  ),
);

const decodeErrorResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })),
);

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message(): string {
    return `herdr ${this.args.join(" ")} exited with ${this.exitCode}: ${this.stderr.trim()}`;
  }

  get targetGone(): boolean {
    return Option.exists(
      decodeErrorResponse(this.stderr.trim()),
      (response) =>
        response.error.code === "pane_not_found" || response.error.code === "tab_not_found",
    );
  }
}

export const herdr = Effect.fn("herdr")(
  function* (args: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make("herdr", args, { detached: false }));

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

const runOwnerAlive = Effect.fn("runOwnerAlive")(function* (
  runDirectory: string,
  launcherPid: number,
) {
  if (isAlive(launcherPid)) return true;

  const paneChild = yield* readInteger(runFiles(runDirectory).started).pipe(
    Effect.asSome,
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
  );

  return Option.exists(paneChild, isAlive);
});

class AbandonedRunError extends Data.TaggedError("AbandonedRunError")<{
  readonly runDirectory: string;
  readonly cause: Error;
}> {
  override get message(): string {
    return `could not remove ${this.runDirectory}: ${this.cause.message}`;
  }
}

type NamedRun = { readonly runDirectory: string; readonly launcherPid: number };

const removeAbandonedRun = Effect.fn("removeAbandonedRun")(
  function* ({ runDirectory, launcherPid }: NamedRun, uid: number) {
    const fs = yield* FileSystem.FileSystem;
    // Absent when another sweep removed it after this one listed the root.
    const info = yield* Effect.try(() => lstatSync(runDirectory, { throwIfNoEntry: false }));

    // makeTempDirectory creates a run directory this way. Anything else, such as another user's
    // directory in a shared temporary directory or a symlink, is not ours to read or remove.
    const privateDirectory =
      info !== undefined && info.isDirectory() && info.uid === uid && (info.mode & 0o777) === 0o700;

    if (!privateDirectory) return Option.none<string>();

    if (yield* runOwnerAlive(runDirectory, launcherPid)) return Option.none<string>();

    yield* fs.remove(runDirectory, { recursive: true, force: true });

    return Option.some(runDirectory);
  },
  (effect, { runDirectory }) =>
    Effect.mapError(effect, (cause) => new AbandonedRunError({ runDirectory, cause })),
);

/**
 * A launcher killed before its pane child starts leaves its run directory, with the launcher's
 * environment in launch.json, and maybe a pane with only a shell in it. Herdr also saves a session
 * before it hangs up its panes, so a subagent pane open at `herdr session stop` comes back on restart
 * in a directory its launcher has since removed.
 */
export const sweepAbandonedRuns = Effect.fn("sweepAbandonedRuns")(function* (
  root: RuntimeRoot,
  uid: number,
) {
  const fs = yield* FileSystem.FileSystem;

  // A name without the launcher's pid gives no way to tell whether its run is over.
  const runs = (yield* fs.readDirectory(root)).flatMap((name): NamedRun[] => {
    const runDirectory = `${root}/${name}`;

    const launcherPid = Option.flatMap(
      parseRunDirectoryName(runDirectory),
      (run) => run.launcherPid,
    );

    if (Option.isNone(launcherPid)) return [];

    return [{ runDirectory, launcherPid: launcherPid.value }];
  });

  const [removed, failed] = yield* Effect.partition(runs, (run) => removeAbandonedRun(run, uid));

  const listed = yield* herdr(["pane", "list"]).pipe(Effect.flatMap(decodePaneList));

  const abandoned = yield* Effect.filter(
    listed.result.panes.filter((pane) => Option.isSome(parseRunDirectoryName(pane.cwd))),
    (pane) => fs.exists(pane.cwd).pipe(Effect.map((exists) => !exists)),
  );

  yield* Effect.forEach(abandoned, (pane) => herdr(["pane", "close", pane.pane_id]));

  return {
    removed: removed.flatMap(Option.toArray),
    failed,
    closed: abandoned.map((pane) => pane.pane_id),
  };
});
