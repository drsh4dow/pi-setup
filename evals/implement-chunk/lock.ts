// A cross-process lock on a state file, so the fake gh and tracker calls a run makes in parallel
// apply one at a time. mkdir is atomic: exactly one caller creates the directory.

import { mkdirSync, rmdirSync } from "node:fs";

const WAIT_MS = 20;

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryMkdir(path: string): boolean {
  try {
    mkdirSync(path);

    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;

    throw error;
  }
}

/** Runs `task` holding the lock on `statePath`, waiting at most `timeoutMs` for it. */
export function withLock<T>(statePath: string, task: () => T, timeoutMs = 60_000): T {
  const lock = `${statePath}.lock`;
  const deadline = Date.now() + timeoutMs;

  while (!tryMkdir(lock)) {
    if (Date.now() > deadline) throw new Error(`${lock} held for ${timeoutMs / 1000}s`);

    sleep(WAIT_MS);
  }

  try {
    return task();
  } finally {
    rmdirSync(lock);
  }
}

export { sleep };
