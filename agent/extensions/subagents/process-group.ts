import { Data, type Duration, Effect, Option } from "effect";

// `bg_kill` sends SIGKILL to the launcher's process group 2 s after SIGTERM, and a group the
// launcher stops must be gone before then.
const TERM_GRACE = "1500 millis";

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

const awaitGroupExit = (group: number, timeout: Duration.Input) =>
  Effect.sleep("20 millis").pipe(
    Effect.repeat({ until: () => !isAlive(-group) }),
    Effect.timeoutOption(timeout),
    Effect.map(Option.isSome),
  );

const signalGroup = (group: number, signal: NodeJS.Signals) =>
  Effect.try({
    try: () => process.kill(-group, signal),
    catch: (cause) => new SignalError({ group, signal, cause }),
  });

/**
 * Gives the group `exitGrace` to leave on its own, then sends SIGTERM and then SIGKILL, and says
 * what ended it.
 */
export const stopProcessGroup = Effect.fn("stopProcessGroup")(function* (
  group: number,
  exitGrace: Duration.Input,
) {
  if (!isAlive(-group) || (yield* awaitGroupExit(group, exitGrace))) return "exited" as const;

  yield* signalGroup(group, "SIGTERM");

  if (yield* awaitGroupExit(group, TERM_GRACE)) return "SIGTERM" as const;

  yield* signalGroup(group, "SIGKILL");

  if (yield* awaitGroupExit(group, KILL_GRACE)) return "SIGKILL" as const;

  return "survived" as const;
});
