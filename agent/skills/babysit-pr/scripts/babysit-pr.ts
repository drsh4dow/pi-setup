#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { candidateEvents } from "./events.ts";
import {
  CommandError,
  DEFAULT_TRUSTED_BOTS,
  fetchSnapshot,
  resolvePr,
  terminalState,
  type Snapshot,
} from "./github.ts";
import { type PullRequest } from "./contracts.ts";
import {
  ackEvents,
  acquireLock,
  atomicJson,
  drainEvents,
  markNotified,
  pendingEvents,
  pendingRecords,
  queueEvents,
  readMeta,
  readWatcherOwner,
  reconcileResolvedReviewComments,
  reconcileResponseMarkers,
  reconcileUnnotifiedCheckEvents,
  statePaths,
  trustedBotSchema,
  type StatePaths,
  type PendingRecord,
} from "./state.ts";

const POLL_MS = 60_000;

const DEBOUNCE_MS = 30_000;

const MAX_DEBOUNCE_MS = 120_000;

const REMINDER_MS = 600_000;

const FAILURE_NOTICE_MS = 300_000;

const MAX_BACKOFF_MS = 60_000;

export function shouldEmit(
  batch: { firstSeenAt: number; lastSeenAt: number; lastEmittedAt: number | null },
  now: number,
  debounceMs = DEBOUNCE_MS,
) {
  if (batch.lastEmittedAt !== null) return now - batch.lastEmittedAt >= REMINDER_MS;

  return now - batch.lastSeenAt >= debounceMs || now - batch.firstSeenAt >= MAX_DEBOUNCE_MS;
}

// Tests shorten the quiet period so they observe delivery without waiting 30 seconds.
function debounceWindow(value: string | undefined) {
  if (value === undefined) return DEBOUNCE_MS;
  const debounceMs = Number(value);

  if (!Number.isInteger(debounceMs) || debounceMs < 0)
    throw new Error(`Invalid BABYSIT_PR_DEBOUNCE_MS: ${value}`);

  return debounceMs;
}

function emit(message: string, cwd: string) {
  const fd = Number(process.env.PI_BACKGROUND_TERMINAL_NOTIFY_FD);

  if (!Number.isInteger(fd) || fd < 3)
    throw new Error(
      "babysit-pr watch requires a Pi-owned background terminal notification channel",
    );
  // Node closes extra descriptors unless explicitly passed to the child.
  execFileSync("emit-to-pi", [message], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe", fd],
    env: { ...process.env, PI_BACKGROUND_TERMINAL_NOTIFY_FD: "3" },
  });
}

export function tryEmit(
  message: string,
  cwd: string,
  emitMessage = emit,
  report = (error: string) => {
    process.stderr.write(`${error}\n`);
  },
) {
  try {
    emitMessage(message, cwd);

    return true;
  } catch (error) {
    report(`babysit-pr could not notify its owner: ${String(error)}`);

    return false;
  }
}

function notificationMessage(
  pr: PullRequest,
  records: PendingRecord[],
  paths: StatePaths,
  reminder: boolean,
) {
  const kinds = [...new Set(records.map(({ event }) => event.kind))].join(", ");

  return `babysit-pr${reminder ? " reminder" : ""}: PR #${pr.number} has ${records.length} pending event${records.length === 1 ? "" : "s"} (${kinds}). Run babysit-pr drain ${pr.url}, follow the babysit-pr skill, then acknowledge each completed event. State: ${paths.root}`;
}

function emitPending(
  cwd: string,
  pr: PullRequest,
  paths: StatePaths,
  records: PendingRecord[],
  reminder: boolean,
) {
  emit(notificationMessage(pr, records, paths, reminder), cwd);
  markNotified(paths, records, Date.now());
}

function poll(cwd: string, reference: string, paths: StatePaths, trustedBots: Set<string>) {
  const previous = readMeta(paths);
  const observedAt = new Date().toISOString();
  const snapshot = fetchSnapshot(cwd, reference, previous, trustedBots);

  if (snapshot.input === null) return snapshot;
  reconcileResponseMarkers(
    paths,
    [...snapshot.input.issueComments, ...snapshot.input.reviewComments],
    snapshot.input.selfLogin,
  );
  reconcileResolvedReviewComments(paths, snapshot.input.unresolvedReviewCommentIds);
  const candidates = candidateEvents(snapshot.input, observedAt);
  reconcileUnnotifiedCheckEvents(paths, candidates);
  queueEvents(paths, candidates);
  atomicJson(paths.meta, {
    version: 1,
    lastPolledAt: new Date().toISOString(),
    pr: snapshot.pr,
    selfLogin: snapshot.input.selfLogin,
    trustedBots: [...trustedBots].toSorted(),
    threadStates: Object.fromEntries(snapshot.input.threadStates),
  });

  return snapshot;
}

async function settleDebounce(
  cwd: string,
  reference: string,
  paths: StatePaths,
  current: Snapshot,
  trustedBots: Set<string>,
  debounceMs: number,
) {
  let snapshot = current;

  for (;;) {
    const records = pendingRecords(paths);
    const unnotified = records.filter((record) => record.emittedAt === null);

    if (unnotified.length === 0) return snapshot;

    const firstSeenAt = Math.min(...unnotified.map(({ event }) => Date.parse(event.observedAt)));

    const lastSeenAt = Math.max(...unnotified.map(({ event }) => Date.parse(event.observedAt)));

    const now = Date.now();

    if (shouldEmit({ firstSeenAt, lastSeenAt, lastEmittedAt: null }, now, debounceMs)) {
      emitPending(cwd, snapshot.pr, paths, records, false);

      return snapshot;
    }

    const dueAt = Math.min(lastSeenAt + debounceMs, firstSeenAt + MAX_DEBOUNCE_MS);

    // oxlint-disable-next-line no-await-in-loop -- Polling, debounce, and backoff must complete before the next poll.
    await sleep(Math.max(1, dueAt - now));
    snapshot = poll(cwd, reference, paths, trustedBots);

    if (terminalState(snapshot.pr)) return snapshot;
  }
}

function maybeRemind(cwd: string, pr: PullRequest, paths: StatePaths) {
  const records = pendingRecords(paths);

  if (records.length === 0 || records.some((record) => record.emittedAt === null)) return;
  const lastEmittedAt = Math.min(...records.map((record) => record.emittedAt ?? Infinity));

  if (shouldEmit({ firstSeenAt: 0, lastSeenAt: 0, lastEmittedAt }, Date.now()))
    emitPending(cwd, pr, paths, records, true);
}

async function watch(cwd: string, reference: string, trustedBots: Set<string>, debounceMs: number) {
  const initial = resolvePr(cwd, reference);
  const paths = statePaths(cwd, initial.identity);
  acquireLock(paths, trustedBots);
  const release = () => rmSync(paths.lock, { recursive: true, force: true });

  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  let failureStartedAt = null;
  let failureNotified = false;
  let backoff = 5_000;

  try {
    for (;;) {
      try {
        let snapshot = poll(cwd, reference, paths, trustedBots);

        if (!terminalState(snapshot.pr))
          // oxlint-disable-next-line no-await-in-loop -- Polling, debounce, and backoff must complete before the next poll.
          snapshot = await settleDebounce(cwd, reference, paths, snapshot, trustedBots, debounceMs);
        const ended = terminalState(snapshot.pr);

        if (ended) {
          emit(
            `babysit-pr: PR #${snapshot.pr.number} was ${ended}; monitoring stopped and its local state was removed.`,
            cwd,
          );
          rmSync(paths.root, { recursive: true, force: true });

          return;
        }

        maybeRemind(cwd, snapshot.pr, paths);
        failureStartedAt = null;
        failureNotified = false;
        backoff = 5_000;
        // oxlint-disable-next-line no-await-in-loop -- Polling, debounce, and backoff must complete before the next poll.
        await sleep(POLL_MS);
      } catch (error) {
        process.stderr.write(`babysit-pr poll failed: ${String(error)}\n`);

        const needsImmediateNotice =
          error instanceof CommandError &&
          (error.status === 4 || /auth|login|permission|forbidden|403/i.test(error.message));

        const now = Date.now();
        failureStartedAt ??= now;

        if (
          !failureNotified &&
          (needsImmediateNotice || now - failureStartedAt >= FAILURE_NOTICE_MS)
        ) {
          tryEmit(`babysit-pr monitoring is impaired for ${reference}: ${String(error)}`, cwd);
          failureNotified = true;
        }

        // oxlint-disable-next-line no-await-in-loop -- Polling, debounce, and backoff must complete before the next poll.
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  } finally {
    release();
  }
}

function contextFor(cwd: string, reference: string) {
  const resolved = resolvePr(cwd, reference);

  return {
    ...resolved,
    paths: statePaths(cwd, resolved.identity),
  };
}

function print(value: JsonValue) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseTrustedBots(args: string[]) {
  const bots = new Set(DEFAULT_TRUSTED_BOTS);

  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--trusted-bot" || !args[index + 1])
      throw new Error("watch accepts repeated --trusted-bot <login> pairs");
    const login = args[index + 1];

    const invalidLogin = `Invalid trusted bot login: ${login}`;

    if (!Value.Check(trustedBotSchema, login)) throw new Error(invalidLogin);
    bots.add(login);
  }

  return bots;
}

async function main() {
  const [action, reference, ...ids] = process.argv.slice(2);

  if (!action || !reference)
    throw new Error("usage: babysit-pr <watch|drain|ack|status> <PR number or URL> [event IDs]");
  const cwd = process.cwd();

  switch (action) {
    case "watch":
      await watch(
        cwd,
        reference,
        parseTrustedBots(ids),
        debounceWindow(process.env.BABYSIT_PR_DEBOUNCE_MS),
      );

      return;
    case "drain": {
      const { paths } = contextFor(cwd, reference);
      print({ state: paths.root, events: drainEvents(paths) });

      return;
    }

    case "ack": {
      if (ids.length === 0) throw new Error("ack requires at least one event ID");
      const { paths } = contextFor(cwd, reference);
      ackEvents(paths, ids);
      print({ acknowledged: [...new Set(ids)] });

      return;
    }

    case "status": {
      const { paths, pr } = contextFor(cwd, reference);
      const meta = readMeta(paths);
      const watcher = readWatcherOwner(paths);
      const owner = watcher.kind === "live" ? watcher.owner : undefined;
      print({
        pr: pr.url,
        state: terminalState(pr) ?? "open",
        watcherPid: owner?.pid ?? null,
        lastPolledAt: meta.lastPolledAt ?? null,
        trustedBots: owner?.trustedBots ?? meta.trustedBots ?? [],
        pending: pendingEvents(paths).length,
        statePath: paths.root,
      });

      return;
    }

    default:
      throw new Error(`Unknown babysit-pr action: ${action}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
