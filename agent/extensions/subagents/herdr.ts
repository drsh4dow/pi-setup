import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Data, Effect, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The file system and process spawner that the launcher and the child extension run on. */
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

/** Runs one herdr CLI command against the session in `HERDR_SOCKET_PATH` and returns its stdout. */
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
