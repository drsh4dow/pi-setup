import { Console, Effect, FileSystem, Fiber, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ChildLaunch, childEnv, type Environment, runFiles, stderrRecorder } from "../launch.ts";

const FORWARDED_STDERR_LIMIT_BYTES = 64 * 1024;

const decodeLaunch = Schema.decodeUnknownEffect(Schema.fromJsonString(ChildLaunch));

const writeAtomically = Effect.fn("writeAtomically")(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(`${path}.partial`, text);
  yield* fs.rename(`${path}.partial`, path);
});

const runPi = Effect.fn("runPi")(function* (
  files: ReturnType<typeof runFiles>,
  paneEnv: Environment,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const launch = yield* fs.readFileString(files.launch).pipe(Effect.flatMap(decodeLaunch));

  yield* fs.remove(files.launch);

  const handle = yield* spawner.spawn(
    ChildProcess.make("pi", launch.args, {
      cwd: launch.cwd,
      env: childEnv(launch.env, paneEnv),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "pipe",
      // The TUI must stay in the pane's foreground process group to read the terminal.
      detached: false,
    }),
  );

  const stderrFile = yield* fs.open(files.stderr, { flag: "a" });
  const record = stderrRecorder(FORWARDED_STDERR_LIMIT_BYTES);

  const copying = yield* handle.stderr.pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => process.stderr.write(chunk)).pipe(
        Effect.andThen(stderrFile.writeAll(record(chunk))),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const exitCode = yield* handle.exitCode;

  // A process pi left behind can hold the stderr pipe open.
  yield* Fiber.join(copying).pipe(Effect.timeout("1 second"), Effect.ignore);

  return exitCode;
}, Effect.scoped);

export const runPaneChild = Effect.fn("runPaneChild")(function* (
  runDirectory: string,
  paneEnv: Environment,
) {
  const files = runFiles(runDirectory);

  yield* writeAtomically(files.started, String(process.pid));

  const exitCode = yield* runPi(files, paneEnv).pipe(
    Effect.catch((error) => Console.error(`pi-subagent: ${error.message}`).pipe(Effect.as(1))),
  );

  yield* writeAtomically(files.exit, String(exitCode));

  return exitCode;
});
