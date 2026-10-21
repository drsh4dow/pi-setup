import { Cause, Console, Effect, FileSystem, Fiber, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ChildLaunch,
  childEnv,
  type Environment,
  runFiles,
  runFlag,
  stderrRecorder,
} from "../launch.ts";
import { isAlive, stopProcessGroup, stopRestOfGroup, TERM_GRACE } from "../process-group.ts";

const FORWARDED_STDERR_LIMIT_BYTES = 64 * 1024;

const LAUNCHER_POLL_INTERVAL = "200 millis";

const decodeLaunch = Schema.decodeUnknownEffect(Schema.fromJsonString(ChildLaunch));

const writeAtomically = Effect.fn("writeAtomically")(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs.writeFileString(`${path}.partial`, text);
  yield* fs.rename(`${path}.partial`, path);
});

/**
 * A launcher killed by SIGKILL cleans up nothing, so the pane child watches it. Linux hands out
 * pids in order up to `pid_max`, so another process cannot take the launcher's pid within one poll.
 */
const launcherExit = (launcherPid: number) =>
  Effect.sleep(LAUNCHER_POLL_INTERVAL).pipe(Effect.repeat({ until: () => !isAlive(launcherPid) }));

/**
 * Pi runs in this process's group, so the group's SIGTERM reaches this process too. Only the
 * group's SIGKILL may end it, after the run directory is gone.
 */
const abandonRun = Effect.fn("abandonRun")(function* (runDirectory: string) {
  const fs = yield* FileSystem.FileSystem;

  yield* fs
    .remove(runDirectory, { recursive: true, force: true })
    .pipe(
      Effect.catch((error) =>
        Console.error(`pi-subagent: could not remove ${runDirectory}: ${error.message}`),
      ),
    );

  const stopped = yield* stopProcessGroup(process.pid, "0 millis");

  return yield* Effect.die(
    new Error(`the pane child outlived pi's process group ${process.pid} (${stopped})`),
  );
}, Effect.uninterruptible);

/**
 * A signal interrupts runPi, and its release of pi waits for pi's graceful shutdown. Forked before pi
 * spawns, the watch is interrupted only after that release.
 */
const watchLauncher = (launcherPid: number, runDirectory: string) =>
  launcherExit(launcherPid).pipe(
    Effect.andThen(abandonRun(runDirectory)),
    Effect.catchCause((cause) => Console.error(`pi-subagent: ${Cause.pretty(cause)}`)),
    Effect.forkScoped,
  );

const runPi = Effect.fn("runPi")(function* (runDirectory: string, paneEnv: Environment) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const files = runFiles(runDirectory);

  const launch = yield* fs.readFileString(files.launch).pipe(Effect.flatMap(decodeLaunch));

  yield* fs.remove(files.launch);
  yield* watchLauncher(launch.launcherPid, runDirectory);

  const handle = yield* spawner.spawn(
    ChildProcess.make("pi", [runFlag(runDirectory), ...launch.args], {
      cwd: launch.cwd,
      env: childEnv(launch.env, paneEnv),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "pipe",
      // The TUI must stay in the pane's foreground process group to read the terminal.
      detached: false,
      // After herdr closes the pane the launcher only waits on this process, so a pi whose
      // shutdown hangs needs this SIGKILL.
      forceKillAfter: TERM_GRACE,
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

/**
 * A descendant, or a Pi that a wrapper forked, can outlive pi's handle in this group, and nothing
 * sends it SIGKILL after this process exits if the launcher has died. A finalizer, so the group's
 * SIGTERM cannot interrupt it.
 */
const endGroup = stopRestOfGroup().pipe(
  Effect.catch((error) => Console.error(`pi-subagent: ${error.message}`)),
);

export const runPaneChild = Effect.fn("runPaneChild")(function* (
  runDirectory: string,
  paneEnv: Environment,
) {
  const files = runFiles(runDirectory);

  yield* writeAtomically(files.started, String(process.pid));

  const exitCode = yield* runPi(runDirectory, paneEnv).pipe(
    Effect.catch((error) => Console.error(`pi-subagent: ${error.message}`).pipe(Effect.as(1))),
  );

  yield* writeAtomically(files.exit, String(exitCode));

  return exitCode;
}, Effect.ensuring(endGroup));
