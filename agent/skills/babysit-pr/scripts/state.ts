import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { parseJson, type Comment, type PrIdentity } from "./contracts.ts";
import { eventSubject, parseEvent, type PrEvent } from "./events.ts";

const VERSION = 1;

export const trustedBotSchema = Type.String({ pattern: "^[A-Za-z0-9-]+\\[bot\\]$" });

const trustedBotsSchema = Type.Array(trustedBotSchema);

const watcherOwnerSchema = Type.Object({
  pid: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  trustedBots: Type.Optional(trustedBotsSchema),
});

function safeComponent(value: string) {
  return encodeURIComponent(value).replaceAll("%", "_");
}

export function statePaths(cwd: string, identity: PrIdentity) {
  const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();

  const common = isAbsolute(raw) ? raw : resolve(cwd, raw);

  const root = join(
    common,
    "pi",
    "babysit-pr",
    safeComponent(identity.host),
    safeComponent(identity.owner),
    safeComponent(identity.repo),
    String(identity.pr),
  );

  return {
    root,
    events: join(root, "events"),
    acks: join(root, "acks"),
    notifications: join(root, "notifications"),
    lock: join(root, "watch.lock"),
    meta: join(root, "meta.json"),
    eventFile: (id: string) => join(root, "events", `${id}.json`),
    ackFile: (id: string) => join(root, "acks", `${id}.json`),
    notificationFile: (id: string) => join(root, "notifications", `${id}.json`),
  };
}

export type StatePaths = ReturnType<typeof statePaths>;

export interface PendingRecord {
  event: PrEvent;
  emittedAt: number | null;
}

const notificationSchema = Type.Object({
  version: Type.Literal(VERSION),
  id: Type.String(),
  emittedAt: Type.Number(),
});

const metaSchema = Type.Object({
  version: Type.Literal(VERSION),
  threadStates: Type.Record(Type.String(), Type.Boolean()),
  selfLogin: Type.Optional(Type.String()),
  trustedBots: Type.Optional(trustedBotsSchema),
  lastPolledAt: Type.Optional(Type.String()),
});

type WatcherOwner = Static<typeof watcherOwnerSchema>;

type Watcher = { kind: "absent" } | { kind: "stale" } | { kind: "live"; owner: WatcherOwner };

function syncDirectory(path: string) {
  let fd;

  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Some filesystems do not permit syncing directories.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function atomicJson(path: string, value: JsonValue) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);

  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function readState<T>(path: string, parse: (text: string) => T): T {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    const corrupt = `${path}.corrupt-${Date.now()}`;

    try {
      renameSync(path, corrupt);
    } catch {}

    throw new Error(`Invalid babysit-pr state moved to ${corrupt}`, { cause: error });
  }
}

function acknowledge(paths: StatePaths, id: string, source?: string) {
  if (existsSync(paths.ackFile(id))) return;
  const record = { version: VERSION, id, acknowledgedAt: new Date().toISOString() };

  if (source) atomicJson(paths.ackFile(id), { ...record, source });
  else atomicJson(paths.ackFile(id), record);
}

function readEvent(paths: StatePaths, id: string) {
  return readState(paths.eventFile(id), (text) => {
    const event = parseEvent(text);

    if (event.id !== id) throw new Error("Event identity does not match its filename");

    return event;
  });
}

export function queueEvents(paths: StatePaths, events: PrEvent[]) {
  const added: PrEvent[] = [];

  if (events.length === 0) return added;
  const stored = new Set<string>();
  const pendingBySubject = new Map<string, Set<string>>();

  for (const name of eventFiles(paths)) {
    const id = basename(name, ".json");
    stored.add(id);

    if (existsSync(paths.ackFile(id))) continue;
    const existing = readEvent(paths, id);
    const subject = eventSubject(existing);
    const pending = pendingBySubject.get(subject) ?? new Set();
    pending.add(id);
    pendingBySubject.set(subject, pending);
  }

  for (const event of events) {
    if (stored.has(event.id)) continue;
    const subject = eventSubject(event);
    const pending = pendingBySubject.get(subject) ?? new Set();

    for (const id of pending) {
      if (id === event.id) continue;
      acknowledge(paths, id, "superseded");
      pending.delete(id);
    }

    atomicJson(paths.eventFile(event.id), event);
    stored.add(event.id);

    if (!existsSync(paths.ackFile(event.id))) pending.add(event.id);
    pendingBySubject.set(subject, pending);
    added.push(event);
  }

  return added;
}

function eventFiles(paths: StatePaths) {
  if (!existsSync(paths.events)) return [];

  return readdirSync(paths.events)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .toSorted();
}

export function pendingRecords(paths: StatePaths) {
  const records: PendingRecord[] = [];

  for (const name of eventFiles(paths)) {
    const id = basename(name, ".json");

    if (existsSync(paths.ackFile(id))) continue;
    const event = readEvent(paths, id);
    let emittedAt = null;

    if (existsSync(paths.notificationFile(id))) {
      const notification = readState(paths.notificationFile(id), (text) => {
        const value = parseJson(notificationSchema, text);

        if (value.id !== id) throw new Error("Notification identity does not match its filename");

        return value;
      });

      emittedAt = notification.emittedAt;
    }

    records.push({ event, emittedAt });
  }

  return records.toSorted(
    (left, right) =>
      left.event.observedAt.localeCompare(right.event.observedAt) ||
      left.event.key.localeCompare(right.event.key),
  );
}

export function pendingEvents(paths: StatePaths) {
  return pendingRecords(paths).map(({ event }) => event);
}

export function drainEvents(paths: StatePaths, now = Date.now()) {
  const records = pendingRecords(paths);
  markNotified(paths, records, now);

  return records.map(({ event }) => event);
}

export function reconcileResolvedReviewComments(
  paths: StatePaths,
  unresolvedReviewCommentIds: Set<number>,
) {
  const acknowledged = [];

  for (const { event } of pendingRecords(paths)) {
    if (event.kind !== "review-comment" || unresolvedReviewCommentIds.has(event.payload.comment.id))
      continue;
    acknowledge(paths, event.id, "thread-resolved");
    acknowledged.push(event.id);
  }

  return acknowledged;
}

export function reconcileUnnotifiedCheckEvents(paths: StatePaths, currentEvents: PrEvent[]) {
  const current = new Set(
    currentEvents
      .values()
      .filter((event) => event.kind === "check-failed")
      .map((event) => event.id),
  );

  for (const record of pendingRecords(paths)) {
    if (
      record.event.kind === "check-failed" &&
      record.emittedAt === null &&
      !current.has(record.event.id)
    ) {
      rmSync(paths.eventFile(record.event.id), { force: true });
      rmSync(paths.notificationFile(record.event.id), { force: true });
    }
  }
}

export function ackEvents(paths: StatePaths, ids: string[]) {
  for (const id of new Set(ids)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !existsSync(paths.eventFile(id)))
      throw new Error(`Unknown babysit-pr event: ${id}`);
    acknowledge(paths, id);
  }
}

export function markNotified(paths: StatePaths, records: PendingRecord[], emittedAt: number) {
  for (const { event } of records)
    atomicJson(paths.notificationFile(event.id), {
      version: VERSION,
      id: event.id,
      emittedAt,
    });
}

export function readMeta(paths: StatePaths): Static<typeof metaSchema> {
  if (!existsSync(paths.meta)) return { version: VERSION, threadStates: {} };

  return readState(paths.meta, (text) => parseJson(metaSchema, text));
}

export function reconcileResponseMarkers(
  paths: StatePaths,
  comments: Comment[],
  selfLogin: string,
) {
  const ids = new Set<string>();

  for (const comment of comments) {
    if (comment.user.login !== selfLogin || comment.body === null) continue;

    for (const match of comment.body.matchAll(/<!-- pi-event:([a-f0-9]{64}) -->/g))
      ids.add(match[1]);
  }

  for (const id of ids)
    if (existsSync(paths.eventFile(id))) acknowledge(paths, id, "github-marker");
}

export function readWatcherOwner(paths: StatePaths): Watcher {
  let owner: WatcherOwner;

  try {
    owner = parseJson(watcherOwnerSchema, readFileSync(join(paths.lock, "owner.json"), "utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      !existsSync(paths.lock)
    )
      return { kind: "absent" };
    // A missing or incomplete owner file may belong to a starting watcher.
    throw new Error(
      `Cannot verify babysit-pr watcher owner at ${paths.lock}. Retry if it is starting; otherwise inspect the lock before removing it.`,
      { cause: error },
    );
  }

  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;

    if (error.code === "ESRCH") return { kind: "stale" };

    if (error.code !== "EPERM") throw error;
  }

  return { kind: "live", owner };
}

export function acquireLock(paths: StatePaths, trustedBots: Set<string>) {
  mkdirSync(paths.root, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(paths.lock);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const watcher = readWatcherOwner(paths);

      if (watcher.kind === "live")
        throw new Error(`babysit-pr is already watching this PR with PID ${watcher.owner.pid}`, {
          cause: error,
        });

      if (watcher.kind === "stale") rmSync(paths.lock, { recursive: true, force: true });
      continue;
    }

    try {
      atomicJson(join(paths.lock, "owner.json"), {
        version: VERSION,
        pid: process.pid,
        trustedBots: [...trustedBots].toSorted(),
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      rmSync(paths.lock, { recursive: true, force: true });
      throw error;
    }

    return;
  }

  throw new Error("Could not acquire the babysit-pr watcher lock");
}
