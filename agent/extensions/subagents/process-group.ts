import { Data, Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TERM_GRACE_MS as JOB_KILL_AFTER_MS } from "../background-terminals/manager.ts";

const SHUTDOWN_START_MS = 1000;

export const TERM_GRACE = Duration.millis(SHUTDOWN_START_MS + JOB_KILL_AFTER_MS);

const KILL_GRACE = "250 millis";

export class SignalError extends Data.TaggedError("SignalError")<{
  readonly group: number;
  readonly signal: NodeJS.Signals;
  readonly cause: unknown;
}> {
  override get message(): string {
    const reason = this.cause instanceof Error ? this.cause.message : "failed";

    return `kill -${this.signal} -${this.group}: ${reason}`;
  }
}

/** A negative pid names a process group, as in `kill(2)`. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

const PROCESS_LINE = /^\s*(\d+)\s+(\d+)\s*$/;

/**
 * `kill(-group, 0)` cannot tell whether this process's group holds any other process. `ps` runs in
 * its own group, so it never lists itself.
 */
const othersInGroup = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const ps = yield* spawner.spawn(
    ChildProcess.make("ps", ["-A", "-o", "pid=,pgid="], { detached: true, stderr: "ignore" }),
  );

  const [listing, exitCode] = yield* Effect.all(
    [ps.stdout.pipe(Stream.decodeText(), Stream.mkString), ps.exitCode],
    { concurrency: "unbounded" },
  );

  const members = listing.split("\n").flatMap((line) => {
    const match = PROCESS_LINE.exec(line);

    return match !== null && Number(match[2]) === process.pid ? [Number(match[1])] : [];
  });

  const complete = exitCode === 0 && members.includes(process.pid);

  return !complete || members.some((pid) => pid !== process.pid);
}).pipe(
  Effect.scoped,
  Effect.orElseSucceed(() => true),
);

const awaitGroupExit = <E, R>(alive: Effect.Effect<boolean, E, R>, timeout: Duration.Input) =>
  Effect.sleep("20 millis").pipe(
    Effect.andThen(alive),
    Effect.repeat({ until: (stillAlive) => !stillAlive }),
    Effect.timeoutOption(timeout),
    Effect.map(Option.isSome),
  );

const signalGroup = (group: number, signal: NodeJS.Signals) =>
  Effect.try({
    try: () => process.kill(-group, signal),
    catch: (cause) => new SignalError({ group, signal, cause }),
  });

const stopGroup = <E, R>(
  group: number,
  exitGrace: Duration.Input,
  alive: Effect.Effect<boolean, E, R>,
) =>
  Effect.gen(function* () {
    if (!(yield* alive) || (yield* awaitGroupExit(alive, exitGrace))) return "exited" as const;

    yield* signalGroup(group, "SIGTERM");

    if (yield* awaitGroupExit(alive, TERM_GRACE)) return "SIGTERM" as const;

    yield* signalGroup(group, "SIGKILL");

    if (yield* awaitGroupExit(alive, KILL_GRACE)) return "SIGKILL" as const;

    return "survived" as const;
  });

export const stopProcessGroup = Effect.fn("stopProcessGroup")(function* (
  group: number,
  exitGrace: Duration.Input,
) {
  return yield* stopGroup(
    group,
    exitGrace,
    Effect.sync(() => isAlive(-group)),
  );
});

export const stopOwnGroup = Effect.fn("stopOwnGroup")(function* () {
  return yield* stopGroup(process.pid, "0 millis", othersInGroup);
});
