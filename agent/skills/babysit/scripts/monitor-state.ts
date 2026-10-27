import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";

declare const attentionIdBrand: unique symbol;
export type AttentionId = string & {
  readonly [attentionIdBrand]: "AttentionId";
};
export function isAttentionId(value: string): value is AttentionId {
  return /^[0-9a-f]{64}$/.test(value);
}
export type AttentionKind =
  | "feedback"
  | "merge-blocker"
  | "merge-ready"
  | "status-unavailable"
  | "status-recovered"
  | "ci-recovered";

export class MonitorStateError extends Error {
  readonly path: string;
  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`${detail} (state: ${path})`, options);
    this.name = "MonitorStateError";
    this.path = path;
  }
}

export type MonitorLane = "lifecycle" | "feedback" | "ci";
export type ConditionKind = Exclude<
  T.MergeBlocker["kind"],
  "review-threads"
>;
export interface Generation {
  readonly active: boolean;
  readonly generation: number;
}
/**
 * A member owes its final read from the poll that first sees it merged or
 * closed until that read's feedback is queued for the agent, or its failure
 * is: a status-unavailable item for the final read. A reopen is neither, so
 * the debt outlives the lifecycle that made it.
 */
export type FinalRead = "owed" | "done";
const FINAL_READS = ["owed", "done"] as const satisfies readonly FinalRead[];
export type Lifecycle =
  | { readonly kind: "unknown" }
  | { readonly kind: "open" }
  | { readonly kind: "merged"; readonly mergedAt: string | null }
  | { readonly kind: "closed" };
export interface PrLedger {
  readonly number: T.PrNumber;
  readonly lifecycle: Lifecycle;
  readonly finalRead: FinalRead;
  readonly feedbackBaselined: boolean;
  readonly seenRevisions: readonly string[];
  readonly conditions: Readonly<Record<ConditionKind, Generation>>;
  readonly outages: Readonly<Record<MonitorLane, Generation>>;
  readonly ciRecoveryOwed: boolean;
}
export interface StoredItem {
  readonly id: AttentionId;
  readonly pr: T.PrNumber;
  readonly kind: AttentionKind;
  readonly acknowledged: boolean;
  /**
   * A bot's revision in a resolved thread. It goes out with the next batch
   * that another item wakes, or with the last batch when the watch finishes,
   * and an unacknowledged held item never wakes the agent alone.
   */
  readonly held: boolean;
  readonly observedAt: string;
  readonly excerpt: string;
  readonly detail: unknown;
}
export interface ScopeRevision {
  readonly from: T.NonEmpty<T.PrNumber>;
  readonly to: T.NonEmpty<T.PrNumber>;
  readonly at: string;
}
export interface Ledger {
  readonly version: 1;
  readonly repository: T.Repository;
  readonly mode: T.WatchMode;
  readonly scope: T.NonEmpty<T.PrNumber>;
  readonly scopeRevisions: readonly ScopeRevision[];
  readonly prs: readonly PrLedger[];
  readonly items: readonly StoredItem[];
}

export const CONDITION_KINDS = [
  "merge-conflicts",
  "failing-checks",
  "merge-gate",
] as const satisfies readonly ConditionKind[];
export const LANES = [
  "lifecycle",
  "feedback",
  "ci",
] as const satisfies readonly MonitorLane[];
const ATTENTION_KINDS = [
  "feedback",
  "merge-blocker",
  "merge-ready",
  "status-unavailable",
  "status-recovered",
  "ci-recovered",
] as const satisfies readonly AttentionKind[];
const MODES = [
  "single",
  "stack",
  "queued-stack",
] as const satisfies readonly T.WatchMode[];
const idle: Generation = { active: false, generation: 0 };

export function newPrLedger(number: T.PrNumber): PrLedger {
  return {
    number,
    lifecycle: { kind: "unknown" },
    finalRead: "done",
    feedbackBaselined: false,
    seenRevisions: [],
    conditions: {
      "merge-conflicts": idle,
      "failing-checks": idle,
      "merge-gate": idle,
    },
    outages: { lifecycle: idle, feedback: idle, ci: idle },
    ciRecoveryOwed: false,
  };
}

class Invalid extends Error {}
function fail(path: string, value: unknown): never {
  throw new Invalid(`invalid ${path}: ${JSON.stringify(value) ?? "undefined"}`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(path, value);
  return Object.fromEntries(Object.entries(value));
}
function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, value);
  return value;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, value);
  return value;
}
function flag(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, value);
  return value;
}
function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    fail(path, value);
  return value;
}
function oneOf<const V extends readonly string[]>(
  value: unknown,
  values: V,
  path: string
): V[number] {
  for (const candidate of values) if (candidate === value) return candidate;
  return fail(path, value);
}
function prNumber(value: unknown, path: string): T.PrNumber {
  try {
    return parsePrNumber(value, path);
  } catch {
    return fail(path, value);
  }
}
function prList(value: unknown, path: string): T.NonEmpty<T.PrNumber> {
  const numbers = nonEmpty(
    array(value, path).map((item, index) => prNumber(item, `${path}[${index}]`))
  );
  if (numbers === null) fail(path, value);
  return numbers;
}
function generation(value: unknown, path: string): Generation {
  const raw = object(value, path);
  return {
    active: flag(raw.active, `${path}.active`),
    generation: count(raw.generation, `${path}.generation`),
  };
}
function lifecycle(value: unknown, path: string): Lifecycle {
  const raw = object(value, path);
  const kind = oneOf(
    raw.kind,
    ["unknown", "open", "merged", "closed"] as const,
    `${path}.kind`
  );
  if (kind !== "merged") return { kind };
  return {
    kind,
    mergedAt:
      raw.mergedAt === null ? null : text(raw.mergedAt, `${path}.mergedAt`),
  };
}
function finalRead(raw: Record<string, unknown>, path: string): FinalRead {
  if (raw.finalRead !== undefined)
    return oneOf(raw.finalRead, FINAL_READS, `${path}.finalRead`);
  // Ledgers written before the final read got its own field saved it inside a
  // merged or closed lifecycle. Ledgers older still saved a member merged or
  // closed only once its final read had landed or failed, so load it as done.
  const saved = object(raw.lifecycle, `${path}.lifecycle`).finalRead;
  if (saved !== undefined)
    return oneOf(saved, FINAL_READS, `${path}.lifecycle.finalRead`);
  return "done";
}
function prLedger(value: unknown, path: string): PrLedger {
  const raw = object(value, path);
  const conditions = object(raw.conditions, `${path}.conditions`);
  const outages = object(raw.outages, `${path}.outages`);
  const condition = (kind: ConditionKind) =>
    generation(conditions[kind], `${path}.conditions.${kind}`);
  const outage = (lane: MonitorLane) =>
    generation(outages[lane], `${path}.outages.${lane}`);
  return {
    number: prNumber(raw.number, `${path}.number`),
    lifecycle: lifecycle(raw.lifecycle, `${path}.lifecycle`),
    finalRead: finalRead(raw, path),
    feedbackBaselined: flag(raw.feedbackBaselined, `${path}.feedbackBaselined`),
    seenRevisions: array(raw.seenRevisions, `${path}.seenRevisions`).map(
      (item, index) => text(item, `${path}.seenRevisions[${index}]`)
    ),
    conditions: {
      "merge-conflicts": condition("merge-conflicts"),
      "failing-checks": condition("failing-checks"),
      "merge-gate": condition("merge-gate"),
    },
    outages: {
      lifecycle: outage("lifecycle"),
      feedback: outage("feedback"),
      ci: outage("ci"),
    },
    ciRecoveryOwed: flag(raw.ciRecoveryOwed, `${path}.ciRecoveryOwed`),
  };
}
function storedItem(value: unknown, path: string): StoredItem {
  const raw = object(value, path);
  const id = text(raw.id, `${path}.id`);
  if (!isAttentionId(id)) fail(`${path}.id`, id);
  if (!("detail" in raw)) fail(`${path}.detail`, undefined);
  return {
    id,
    pr: prNumber(raw.pr, `${path}.pr`),
    kind: oneOf(raw.kind, ATTENTION_KINDS, `${path}.kind`),
    acknowledged: flag(raw.acknowledged, `${path}.acknowledged`),
    // Ledgers written before held items existed have no `held` field. Load
    // their items as not held.
    held: raw.held === undefined ? false : flag(raw.held, `${path}.held`),
    observedAt: text(raw.observedAt, `${path}.observedAt`),
    excerpt: text(raw.excerpt, `${path}.excerpt`),
    detail: raw.detail,
  };
}
export function parseLedger(value: unknown): Ledger {
  const raw = object(value, "state");
  if (raw.version !== 1) fail("state.version", raw.version);
  const repository = object(raw.repository, "state.repository");
  const prs = array(raw.prs, "state.prs").map((item, index) =>
    prLedger(item, `state.prs[${index}]`)
  );
  const scope = prList(raw.scope, "state.scope");
  for (const number of scope)
    if (!prs.some((pr) => pr.number === number))
      fail("state.prs (missing scope member)", number);
  return {
    version: 1,
    repository: {
      owner: text(repository.owner, "state.repository.owner"),
      repo: text(repository.repo, "state.repository.repo"),
    },
    mode: oneOf(raw.mode, MODES, "state.mode"),
    scope,
    scopeRevisions: array(raw.scopeRevisions, "state.scopeRevisions").map(
      (item, index) => {
        const path = `state.scopeRevisions[${index}]`;
        const revision = object(item, path);
        return {
          from: prList(revision.from, `${path}.from`),
          to: prList(revision.to, `${path}.to`),
          at: text(revision.at, `${path}.at`),
        };
      }
    ),
    prs,
    items: array(raw.items, "state.items").map((item, index) =>
      storedItem(item, `state.items[${index}]`)
    ),
  };
}

export const statePath = (directory: string): string =>
  join(directory, "state.json");

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

export interface StateLock {
  readonly path: string;
  readonly contents: string;
}

function readLock(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

/** Linking a fully written file is an exclusive create, like O_EXCL, without a window where the lock exists but is still empty. */
function publishLock(lock: StateLock): boolean {
  const staged = `${lock.path}.${randomUUID()}.tmp`;
  const file = openSync(staged, "wx");
  try {
    writeSync(file, lock.contents);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  try {
    linkSync(staged, lock.path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return false;
    throw error;
  } finally {
    unlinkSync(staged);
  }
}

function setAsideStaleLock(path: string, staleContents: string): void {
  const aside = `${path}.stale.${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (readFileSync(aside, "utf8") !== staleContents)
    try {
      linkSync(aside, path);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
  unlinkSync(aside);
}

const RECLAIM_ATTEMPTS = 3;

export function lockState(directory: string): StateLock {
  const path = join(directory, "watcher.lock");
  const lock = { path, contents: `${process.pid} ${randomUUID()}\n` };
  try {
    mkdirSync(directory, { recursive: true });
    for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt += 1) {
      if (publishLock(lock)) return lock;
      const held = readLock(path);
      if (held === null) continue;
      const pid = Number(/^(\d+) /.exec(held)?.[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new MonitorStateError(
          path,
          `the watcher lock on ${directory} is unreadable: ${JSON.stringify(held)}`
        );
      if (processAlive(pid))
        throw new MonitorStateError(
          path,
          `another watcher owns ${directory} (pid ${pid})`
        );
      setAsideStaleLock(path, held);
    }
  } catch (error) {
    if (error instanceof MonitorStateError) throw error;
    throw new MonitorStateError(path, "cannot take the watcher lock", {
      cause: error,
    });
  }
  throw new MonitorStateError(
    path,
    `the watcher lock on ${directory} changed hands ${RECLAIM_ATTEMPTS} times while being reclaimed`
  );
}

export function unlockState(lock: StateLock): void {
  try {
    if (readLock(lock.path) === lock.contents) unlinkSync(lock.path);
  } catch (error) {
    throw new MonitorStateError(lock.path, "cannot release the watcher lock", {
      cause: error,
    });
  }
}

export function loadLedger(directory: string): Ledger | null {
  const path = statePath(directory);
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw new MonitorStateError(path, "cannot read monitor state", {
      cause: error,
    });
  }
  try {
    return parseLedger(JSON.parse(contents));
  } catch (error) {
    if (!(error instanceof Invalid) && !(error instanceof SyntaxError))
      throw error;
    throw new MonitorStateError(
      path,
      `corrupt or incompatible monitor state, refusing to reset it: ${error.message}`,
      { cause: error }
    );
  }
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "wx");
  try {
    writeSync(file, contents);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function saveLedger(directory: string, ledger: Ledger): void {
  const path = statePath(directory);
  try {
    writeAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`);
  } catch (error) {
    throw new MonitorStateError(path, "cannot write monitor state", {
      cause: error,
    });
  }
}

export function writeBatch(
  directory: string,
  batch: {
    readonly repository: T.Repository;
    readonly createdAt: string;
    readonly items: readonly StoredItem[];
  }
): { readonly path: string; readonly sha256: string } {
  const contents = `${JSON.stringify(
    {
      schemaVersion: 1,
      repository: batch.repository,
      createdAt: batch.createdAt,
      items: batch.items.map((item) => ({
        id: item.id,
        pr: item.pr,
        kind: item.kind,
        observedAt: item.observedAt,
        excerpt: item.excerpt,
        detail: item.detail,
      })),
    },
    null,
    2
  )}\n`;
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const path = join(directory, "batches", `${sha256}.json`);
  try {
    writeAtomic(path, contents);
  } catch (error) {
    throw new MonitorStateError(path, "cannot write attention batch", {
      cause: error,
    });
  }
  return { path, sha256 };
}
