// One writer at a time for a state file that a command rewrites whole. The coordinator and its
// final-PR owners run `chunk unit set` on one units.tsv at once, and each reads the table, changes
// a row, and renames a new table into place, so without the lock the last rename drops the other
// writers' rows.
//
// The lock is `<file>.lock`, holding the holder's PID, and only its holder removes it. A lock whose
// PID no process holds is refused, never cleared, because a writer cannot remove a lock and know in
// the same step that the lock it removed is still the dead one rather than a live writer's that
// replaced it.

import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Refusal } from "./tsv.ts";

/** How long a writer waits for a running holder. A write holds the lock for milliseconds. */
const LOCK_WAIT_MS = 5_000;

/** Whether `error` is a Node system error with this `code`, such as `EEXIST`. */
export function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Creates `path` holding `text` unless it exists, and says whether it did. The file appears whole,
 * by a hard link of a finished file, so a concurrent reader never sees it half written.
 */
export function createWhole(path: string, text: string): boolean {
  const temporary = `${path}.${process.pid}.tmp`;

  writeFileSync(temporary, text);

  try {
    linkSync(temporary, path);

    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;

    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

type Holder =
  | { readonly kind: "gone" }
  | { readonly kind: "pid"; readonly pid: number }
  | { readonly kind: "unreadable" };

function holderOf(lock: string): Holder {
  let text: string;

  try {
    text = readFileSync(lock, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { kind: "gone" };

    throw error;
  }

  const pid = /^[1-9][0-9]*\n$/.test(text) ? Number(text) : Number.NaN;

  return Number.isSafeInteger(pid) ? { kind: "pid", pid } : { kind: "unreadable" };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM: the process exists under another user.
    return !hasCode(error, "ESRCH");
  }
}

/**
 * Whether a lock whose holder has ended was left behind: a holder releases before it exits, so a
 * lock that still names it was never released. A lock that changed meanwhile was released.
 */
function leftBehind(lock: string, holder: Holder): boolean {
  const now = holderOf(lock);

  return now.kind === "pid" && holder.kind === "pid" && now.pid === holder.pid;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lock: string): void {
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    if (createWhole(lock, `${process.pid}\n`)) return;

    const holder = holderOf(lock);

    if (holder.kind === "gone") continue;

    if (holder.kind === "pid" && !isRunning(holder.pid)) {
      if (leftBehind(lock, holder)) {
        throw new Refusal(
          `${lock}: its holder, pid ${holder.pid}, ended without releasing it; ` +
            `remove ${lock} once no chunk command runs, then rerun`,
        );
      }

      continue;
    }

    if (Date.now() >= deadline) {
      throw new Refusal(
        holder.kind === "pid"
          ? `${lock}: another writer holds it (pid ${holder.pid}, which still runs) after ` +
              `${LOCK_WAIT_MS / 1000} s; rerun, or remove the lock if that process is not a chunk command`
          : `${lock} holds no readable pid after ${LOCK_WAIT_MS / 1000} s; ` +
              `remove it once no chunk command runs, then rerun`,
      );
    }

    pause(5 + Math.random() * 20);
  }
}

/** Runs `write` while holding `<path>.lock`, and releases the lock however `write` ends. */
export function withLock<T>(path: string, write: () => T): T {
  const lock = `${path}.lock`;

  acquire(lock);

  try {
    return write();
  } finally {
    rmSync(lock, { force: true });
  }
}
