import { Data, Duration, Effect, Option } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TERM_GRACE_MS as TERMINAL_TERM_GRACE_MS } from "../background-terminals/manager.ts";

/** Pi's graceful shutdown sends its background terminals SIGKILL after their own grace. */
export const TERM_GRACE = Duration.millis(TERMINAL_TERM_GRACE_MS + 1000);

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

export class GroupListError extends Data.TaggedError("GroupListError")<{
  readonly group: number;
  readonly reason: string;
}> {
  override get message(): string {
    return `could not list process group ${this.group}: ${this.reason}`;
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
 * `kill(-group, 0)` cannot tell whether a group holds any process but this one. `ps` runs in its own
 * group, so it never lists itself, and a listing without this process is not a listing.
 */
const othersInGroup = Effect.fn("othersInGroup")(function* (group: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const lines = yield* spawner
    .lines(ChildProcess.make("ps", ["-A", "-o", "pid=,pgid="], { detached: true }))
    .pipe(Effect.mapError((error) => new GroupListError({ group, reason: error.message })));

  const members = lines.flatMap((line) => {
    const match = PROCESS_LINE.exec(line);

    return match !== null && Number(match[2]) === group ? [Number(match[1])] : [];
  });

  if (!members.includes(process.pid)) {
    return yield* new GroupListError({ group, reason: "ps did not list this process" });
  }

  return members.some((pid) => pid !== process.pid);
});

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

/**
 * Stops every other process in this process's group, which this process leads. The group's SIGTERM
 * reaches this process too, and the group's SIGKILL ends it when another process outlives the grace.
 */
export const stopRestOfGroup = Effect.fn("stopRestOfGroup")(function* () {
  return yield* stopGroup(process.pid, "0 millis", othersInGroup(process.pid));
});
