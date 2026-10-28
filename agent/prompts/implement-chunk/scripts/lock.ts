// One writer at a time for a state file that a command rewrites whole. Several coordinators and
// final-PR owners run `chunk unit set` on one units.tsv at once, and each reads the table, changes
// a row, and renames a new table into place, so without the lock the last rename drops the other
// writers' rows.
//
// The lock is `<file>.lock`, holding the holder's PID. It is created whole, by a hard link of a
// finished file, so a waiter never reads it half written. Only its holder removes it. A lock
// whose PID no process holds was left by a writer that was killed mid-write: it is refused, never
// cleared, because a writer cannot remove a lock and know in the same step that the lock it
// removed is still the dead one rather than a live writer's that replaced it. A lock whose holder
// still runs is waited on for LOCK_WAIT_MS, then refused. Both refusals name the lock and its PID.

import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Refusal } from "./tsv.ts";

/** How long a writer waits for a running holder. A write holds the lock for milliseconds. */
export const LOCK_WAIT_MS = 5_000;

type Holder =
  | { readonly kind: "gone" }
  | { readonly kind: "pid"; readonly pid: number }
  | { readonly kind: "unreadable" };

function holderOf(lock: string): Holder {
  let text: string;

  try {
    text = readFileSync(lock, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "gone" };

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
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lock: string): void {
  const token = `${lock}.${process.pid}.tmp`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  writeFileSync(token, `${process.pid}\n`);

  try {
    for (;;) {
      try {
        linkSync(token, lock);

        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }

      const holder = holderOf(lock);

      if (holder.kind === "pid" && !isRunning(holder.pid)) {
        // A holder releases before it exits, so a lock that still names it once it has ended
        // was left behind. A lock that changed meanwhile was released and maybe retaken.
        const now = holderOf(lock);

        if (now.kind === "pid" && now.pid === holder.pid)
          throw new Refusal(
            `${lock}: its holder, pid ${holder.pid}, ended without releasing it; ` +
              `remove ${lock} once no chunk command runs, then rerun`,
          );
      } else if (holder.kind !== "gone") {
        if (Date.now() >= deadline) {
          const who =
            holder.kind === "pid" ? `pid ${holder.pid}, which still runs` : "no readable pid";

          throw new Refusal(
            `${lock}: another writer holds it (${who}) after ${LOCK_WAIT_MS / 1000} s; ` +
              `rerun, or remove the lock if that process is not a chunk command`,
          );
        }

        pause(5 + Math.random() * 20);
      }
    }
  } finally {
    rmSync(token, { force: true });
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
