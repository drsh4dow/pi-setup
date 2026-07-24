import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { ChildActivity } from "./activity.ts";
import {
  type DelegateEffort,
  type DelegateSnapshot,
  type DelegateStatus,
  type DelegateThinking,
  type DelegateWorkspace,
  MAX_ACTIVE_CHILDREN,
  MAX_PENDING_CHILDREN,
  MAX_TRACKED_CHILDREN,
} from "./contract.ts";
import { errorMessage } from "./errors.ts";
import {
  type ChildSession,
  createChild,
  modelName,
  resolveDelegateModel,
  shutdownChild,
  thinkingForEffort,
} from "./runtime.ts";

const MAX_PENDING_SENDS = 8;
const STEER_TIMEOUT_MS = 5_000;
const CREATION_TIMEOUT_MS = 30_000;
const DISPOSAL_TIMEOUT_MS = 16_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
export const MAX_CONCURRENT_WAITS_PER_CHILD = 4;

export interface DelegateRequest {
  task: string;
  effort?: string;
  workspace?: string;
  schema?: unknown;
  background?: boolean;
  ctx: ExtensionContext;
}

interface Deferred {
  promise: Promise<DelegateSnapshot>;
  resolve: (snapshot: DelegateSnapshot) => void;
}

interface Job {
  id: string;
  task: string;
  effort: DelegateEffort;
  thinking: DelegateThinking;
  workspace: DelegateWorkspace;
  schema?: unknown;
  structured?: unknown;
  ctx: ExtensionContext;
  requestedModel: string;
  fallbackReason?: string;
  modelChoice: ExtensionContext["model"];
  model?: string;
  status: DelegateStatus;
  createdAt: number;
  settledAt?: number;
  settlementOrder: number;
  error?: string;
  activity: ChildActivity;
  child?: ChildSession;
  unsubscribe?: () => void;
  stopping?: boolean;
  stopPromise?: Promise<void>;
  completion: Deferred;
  ownership: AbortController;
  sendChain: Promise<void>;
  pendingSends: number;
  deliveryPending: boolean;
  deliveryWaiters: number;
  waiters: number;
}

export interface DelegateManagerOptions {
  createSession?: (
    request: DelegateRequest,
    model: ExtensionContext["model"],
    thinking: DelegateThinking,
    captureStructured: (value: unknown) => void,
    signal: AbortSignal,
  ) => Promise<ChildSession>;
  shutdownSession?: (child: ChildSession) => Promise<void>;
  onSettled?: (snapshot: DelegateSnapshot) => void;
}

function deferred(): Deferred {
  let resolve!: (snapshot: DelegateSnapshot) => void;
  const promise = new Promise<DelegateSnapshot>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Operation aborted");
}

async function waitUntil(
  promises: readonly Promise<unknown>[],
  deadline: number,
): Promise<void> {
  if (promises.length === 0 || Date.now() >= deadline) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export class DelegateManager {
  private readonly jobs = new Map<string, Job>();
  private readonly pending: Job[] = [];
  private readonly active = new Set<string>();
  private readonly createSession: NonNullable<
    DelegateManagerOptions["createSession"]
  >;
  private readonly shutdownSession: NonNullable<
    DelegateManagerOptions["shutdownSession"]
  >;
  private readonly onSettled?: (snapshot: DelegateSnapshot) => void;
  private readonly listeners = new Set<(snapshot: DelegateSnapshot) => void>();
  private readonly runTasks = new Set<Promise<void>>();
  private readonly lateCreations = new Set<Promise<void>>();
  private readonly disposals = new Set<Promise<void>>();
  private readonly childDisposals = new WeakMap<object, Promise<void>>();
  private nextId = 0;
  private nextSettlementOrder = 0;
  private disposed = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: DelegateManagerOptions = {}) {
    this.createSession =
      options.createSession ??
      ((request, model, thinking, captureStructured, signal) =>
        Effect.runPromise(
          createChild(request.ctx, model, thinking, {
            schema: request.schema,
            captureStructured,
          }),
          { signal },
        ));
    this.shutdownSession = options.shutdownSession ?? shutdownChild;
    this.onSettled = options.onSettled;
  }

  subscribe(listener: (snapshot: DelegateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  spawn(request: DelegateRequest): DelegateSnapshot {
    if (this.disposed) throw new Error("Delegate manager is shutting down.");
    if (!request.task.trim())
      throw new Error("Delegated task must not be empty.");
    if (this.pending.length >= MAX_PENDING_CHILDREN) {
      throw new Error(
        `Delegate queue is full (${MAX_PENDING_CHILDREN} pending children).`,
      );
    }
    this.pruneTracked();
    if (this.jobs.size >= MAX_TRACKED_CHILDREN) {
      throw new Error(
        `Delegate registry is full (${MAX_TRACKED_CHILDREN} tracked children).`,
      );
    }

    const modelChoice = resolveDelegateModel(request.ctx);
    const effort = request.effort === "thorough" ? "thorough" : "fast";
    const job: Job = {
      id: `delegate-${++this.nextId}`,
      task: request.task,
      effort,
      thinking: thinkingForEffort(effort),
      workspace: request.workspace === "write" ? "write" : "read",
      schema: request.schema,
      ctx: request.ctx,
      requestedModel: modelChoice.requestedModel,
      fallbackReason: modelChoice.fallbackReason,
      modelChoice: modelChoice.model,
      model: modelName(modelChoice.model),
      status: "queued",
      createdAt: Date.now(),
      settlementOrder: 0,
      activity: new ChildActivity(),
      completion: deferred(),
      ownership: new AbortController(),
      sendChain: Promise.resolve(),
      pendingSends: 0,
      deliveryPending: request.background === true,
      deliveryWaiters: 0,
      waiters: 0,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job);
    this.schedule();
    const snapshot = this.snapshot(job);
    this.notify(snapshot);
    return snapshot;
  }

  list(ids?: readonly string[]): DelegateSnapshot[] {
    if (ids) {
      return [...new Set(ids)].map((id) => this.snapshot(this.requireJob(id)));
    }
    return [...this.jobs.values()]
      .sort((a, b) => {
        const active = (job: Job) =>
          job.status === "queued" || job.status === "running" ? 0 : 1;
        return active(a) - active(b) || b.settlementOrder - a.settlementOrder;
      })
      .map((job) => this.snapshot(job));
  }

  recentActivity(id: string): readonly string[] {
    return this.requireJob(id).activity.recent();
  }

  async wait(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<DelegateSnapshot[]> {
    const jobs = [...new Set(ids)].map((id) => this.requireJob(id));
    if (jobs.length === 0) throw new Error("Provide at least one delegate id.");
    if (signal?.aborted) throw abortError(signal);
    const saturated = jobs.find(
      (job) => job.waiters >= MAX_CONCURRENT_WAITS_PER_CHILD,
    );
    if (saturated) {
      throw new Error(
        `Delegate ${saturated.id} already has ${MAX_CONCURRENT_WAITS_PER_CHILD} pending waits.`,
      );
    }
    for (const job of jobs) job.waiters++;
    const claims = jobs.filter((job) => {
      if (!job.deliveryPending) return false;
      job.deliveryWaiters++;
      return true;
    });
    const completion = Promise.all(
      jobs.map((job) =>
        job.status === "queued" || job.status === "running"
          ? job.completion.promise
          : Promise.resolve(this.snapshot(job)),
      ),
    );
    let completed = false;
    try {
      const snapshots = signal
        ? await Promise.race([
            completion,
            new Promise<never>((_resolve, reject) => {
              const onAbort = () => reject(abortError(signal));
              signal.addEventListener("abort", onAbort, { once: true });
              void completion.finally(() =>
                signal.removeEventListener("abort", onAbort),
              );
            }),
          ])
        : await completion;
      completed = true;
      for (const job of claims) job.deliveryPending = false;
      return snapshots;
    } finally {
      for (const job of jobs) job.waiters--;
      for (const job of claims) {
        job.deliveryWaiters--;
        if (
          !completed &&
          job.deliveryWaiters === 0 &&
          job.deliveryPending &&
          job.status !== "queued" &&
          job.status !== "running"
        ) {
          this.onSettled?.(this.snapshot(job));
        }
      }
    }
  }

  async send(id: string, message: string): Promise<DelegateSnapshot> {
    const job = this.requireJob(id);
    const text = message.trim();
    if (!text) throw new Error("Delegate message must not be empty.");
    if (job.status !== "running") {
      throw new Error(
        `Delegate ${id} is ${job.status}; send requires a running child.`,
      );
    }
    if (!job.child) throw new Error(`Delegate ${id} has no active session.`);
    if (job.pendingSends >= MAX_PENDING_SENDS) {
      throw new Error(
        `Delegate ${id} already has ${MAX_PENDING_SENDS} pending messages.`,
      );
    }
    const child = job.child;
    job.pendingSends++;
    const sending = job.sendChain.then(async () => {
      if (
        job.status !== "running" ||
        job.child !== child ||
        job.ownership.signal.aborted
      ) {
        throw new Error(
          `Delegate ${id} settled before the queued message could be sent.`,
        );
      }
      await this.steerOwned(job, child, text);
    });
    job.sendChain = sending.catch(() => {});
    try {
      await sending;
    } finally {
      job.pendingSends--;
    }
    const snapshot = this.snapshot(job);
    this.notify(snapshot);
    return snapshot;
  }

  async cancel(ids: readonly string[]): Promise<DelegateSnapshot[]> {
    const jobs = [...new Set(ids)].map((id) => this.requireJob(id));
    for (const job of jobs) job.deliveryPending = false;
    await Promise.all(jobs.map((job) => this.stopOwned(job)));
    return jobs.map((job) => this.snapshot(job));
  }

  acknowledge(ids: readonly string[]) {
    for (const id of new Set(ids)) {
      const job = this.jobs.get(id);
      if (job) job.deliveryPending = false;
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.disposed = true;
    this.shutdownPromise = this.shutdownOwned();
    return this.shutdownPromise;
  }

  private async shutdownOwned(): Promise<void> {
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    const jobs = [...this.jobs.values()];
    const stopping = jobs.map((job) =>
      job.status === "queued" || job.status === "running"
        ? this.stopOwned(job)
        : Promise.resolve(),
    );
    await waitUntil(stopping, deadline);
    await waitUntil([...this.runTasks], deadline);
    await waitUntil([...this.lateCreations, ...this.disposals], deadline);
    this.pending.length = 0;
    this.active.clear();
  }

  private schedule() {
    if (this.disposed || this.pending.length === 0) return;
    while (
      this.pending.length > 0 &&
      this.runTasks.size + this.lateCreations.size + this.disposals.size <
        MAX_ACTIVE_CHILDREN
    ) {
      const next = this.pending[0];
      if (!this.canRun(next)) return;
      this.pending.shift();
      this.active.add(next.id);
      next.status = "running";
      this.notify(this.snapshot(next));
      const task = this.run(next).catch((error) => {
        if (next.status === "running" && !next.stopping) {
          this.finalize(next, "error", errorMessage(error));
        }
      });
      this.runTasks.add(task);
      void task.then(
        () => {
          this.runTasks.delete(task);
          this.schedule();
        },
        () => {
          this.runTasks.delete(task);
          this.schedule();
        },
      );
    }
  }

  private canRun(job: Job): boolean {
    if (this.active.size === 0) return true;
    if (job.workspace === "write") return false;
    return ![...this.active].some(
      (id) => this.jobs.get(id)?.workspace === "write",
    );
  }

  private async run(job: Job) {
    if (!job.child) {
      const request: DelegateRequest = {
        task: job.task,
        effort: job.effort,
        workspace: job.workspace,
        schema: job.schema,
        ctx: job.ctx,
      };
      const signal = job.ownership.signal;
      const creation = this.createSession(
        request,
        job.modelChoice,
        job.thinking,
        (value) => {
          if (job.status !== "running") return;
          if (job.structured !== undefined) {
            throw new Error(
              "structured_output may be called only once per run.",
            );
          }
          job.structured = value;
        },
        signal,
      );
      const timeoutError = new Error(
        `Delegate ${job.id} session creation timed out.`,
      );
      let onEnded: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        job.child = await Promise.race([
          creation,
          new Promise<never>((_resolve, reject) => {
            onEnded = () => reject(abortError(signal));
            signal.addEventListener("abort", onEnded, { once: true });
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(timeoutError), CREATION_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        if (error === timeoutError) {
          this.ownLateCreation(creation, job.id);
          this.endOwnership(job, timeoutError);
          if (job.status === "running" && !job.stopping) {
            this.finalize(job, "error", timeoutError.message);
          }
          return;
        }
        if (!signal.aborted) throw error;
        this.ownLateCreation(creation, job.id);
        return;
      } finally {
        if (timer) clearTimeout(timer);
        if (onEnded) signal.removeEventListener("abort", onEnded);
      }
      if (job.status !== "running") {
        const child = job.child;
        job.child = undefined;
        await this.disposeOwned(child, job.id);
        return;
      }
      job.model = modelName(job.child.model ?? job.modelChoice);
      job.unsubscribe = job.child.subscribe((event) =>
        this.onEvent(job, event),
      );
    }

    const child = job.child;
    try {
      const instruction =
        job.schema === undefined
          ? job.task
          : `${job.task}\n\nReturn the final result by calling structured_output exactly once as your final action. Do not write text after that call.`;
      await this.untilOwnershipEnds(
        job,
        child.prompt(instruction, {
          expandPromptTemplates: false,
          source: "extension",
        }),
      );
      if (job.status !== "running" || job.stopping) return;
      const activity = job.activity.state();
      if (activity.assistantStop === "error") {
        this.finalize(
          job,
          "error",
          activity.assistantError ?? "Child agent failed.",
        );
        return;
      }
      if (activity.assistantStop === "aborted") {
        this.finalize(
          job,
          "cancelled",
          activity.assistantError ?? "Child agent aborted.",
        );
        return;
      }
      if (job.schema !== undefined && job.structured === undefined) {
        this.finalize(
          job,
          "error",
          "Child finished without producing the required structured output.",
        );
        return;
      }
      this.finalize(job, "done");
    } catch (error) {
      if (job.status !== "running" || job.stopping) return;
      this.finalize(job, "error", errorMessage(error));
    }
  }

  private onEvent(job: Job, event: Parameters<ChildActivity["capture"]>[0]) {
    job.activity.capture(event);
    this.notify(this.snapshot(job));
  }

  private stopOwned(job: Job): Promise<void> {
    if (job.stopPromise) return job.stopPromise;
    const stopping = this.stop(job).finally(() => {
      if (job.stopPromise === stopping) job.stopPromise = undefined;
    });
    job.stopPromise = stopping;
    return stopping;
  }

  private async stop(job: Job) {
    this.endOwnership(job, new Error(`Delegate ${job.id} ownership ended.`));
    if (job.status === "queued") {
      const index = this.pending.indexOf(job);
      if (index >= 0) this.pending.splice(index, 1);
      this.finalize(job, "cancelled", "Delegation cancelled");
      return;
    }
    if (job.status !== "running" || job.stopping) return;
    job.stopping = true;
    if (job.child) {
      const child = job.child;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abortFailure: unknown;
      const stopped = await Promise.race([
        child.abort().then(
          () => true,
          (error) => {
            abortFailure = error;
            return false;
          },
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!stopped) {
        const evidence = abortFailure
          ? errorMessage(abortFailure).replace(/\s+/g, " ").slice(0, 512)
          : "timed out after 5000ms";
        console.error(`[delegate] abort failed for ${job.id}: ${evidence}`);
      }
      if (!stopped || child.isStreaming) {
        job.child = undefined;
        job.unsubscribe?.();
        job.unsubscribe = undefined;
        await this.disposeOwned(child, job.id);
      }
    }
    if (job.status === "running") {
      const child = job.child;
      this.finalize(job, "cancelled", "Delegation cancelled");
      if (child) await this.disposeOwned(child, job.id);
    }
  }

  private finalize(job: Job, status: DelegateStatus, error?: string) {
    this.endOwnership(job, new Error(`Delegate ${job.id} ownership ended.`));
    job.status = status;
    job.settledAt = Date.now();
    job.settlementOrder = ++this.nextSettlementOrder;
    job.error = error;
    job.stopping = undefined;
    this.active.delete(job.id);
    const snapshot = this.snapshot(job);
    job.completion.resolve(snapshot);
    this.notify(snapshot);
    if (job.deliveryPending && job.deliveryWaiters === 0) {
      this.onSettled?.(snapshot);
    }
    const child = job.child;
    job.child = undefined;
    job.unsubscribe?.();
    job.unsubscribe = undefined;
    if (child) void this.disposeOwned(child, job.id);
    this.pruneTracked();
    this.schedule();
  }

  private snapshot(job: Job): DelegateSnapshot {
    const activity = job.activity.state();
    return {
      id: job.id,
      status: job.status,
      workspace: job.workspace,
      createdAt: job.createdAt,
      settledAt: job.settledAt,
      output: activity.output,
      structured: job.structured,
      success: job.status === "done",
      assignedTask: job.task,
      effort: job.effort,
      requestedModel: job.requestedModel,
      model: job.model,
      thinking: job.thinking,
      fallbackReason: job.fallbackReason,
      durationMs: (job.settledAt ?? Date.now()) - job.createdAt,
      toolCalls: activity.toolCalls,
      failedToolCalls: activity.failedToolCalls,
      childUsage: activity.usage,
      aborted: job.status === "cancelled",
      error: job.error,
    };
  }

  private notify(snapshot: DelegateSnapshot) {
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Progress listeners do not own child lifecycle state.
      }
    }
  }

  private requireJob(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown delegate id "${id}".`);
    return job;
  }

  private pruneTracked() {
    if (this.jobs.size < MAX_TRACKED_CHILDREN) return;
    const settled = [...this.jobs.values()]
      .filter(
        (job) =>
          job.status !== "queued" &&
          job.status !== "running" &&
          !job.deliveryPending,
      )
      .sort((a, b) => a.settlementOrder - b.settlementOrder);
    while (this.jobs.size >= MAX_TRACKED_CHILDREN && settled.length > 0) {
      const job = settled.shift();
      if (!job) break;
      this.jobs.delete(job.id);
      if (job.child) {
        const child = job.child;
        job.child = undefined;
        job.unsubscribe?.();
        void this.disposeOwned(child, job.id);
      }
    }
  }

  private endOwnership(job: Job, reason: Error) {
    if (!job.ownership.signal.aborted) job.ownership.abort(reason);
  }

  private async steerOwned(job: Job, child: ChildSession, text: string) {
    const signal = job.ownership.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onEnded: (() => void) | undefined;
    const ended = new Promise<never>((_resolve, reject) => {
      onEnded = () => reject(abortError(signal));
      signal.addEventListener("abort", onEnded, { once: true });
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Delegate ${job.id} steering timed out.`);
        this.endOwnership(job, error);
        void this.stopOwned(job);
        reject(error);
      }, STEER_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([child.steer(text), ended, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onEnded) signal.removeEventListener("abort", onEnded);
    }
  }

  private async untilOwnershipEnds(job: Job, operation: Promise<unknown>) {
    const signal = job.ownership.signal;
    let onEnded: (() => void) | undefined;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          onEnded = () => reject(abortError(signal));
          signal.addEventListener("abort", onEnded, { once: true });
        }),
      ]);
    } finally {
      if (onEnded) signal.removeEventListener("abort", onEnded);
    }
  }

  private ownLateCreation(creation: Promise<ChildSession>, id: string) {
    let cleanup: Promise<void>;
    cleanup = creation.then(
      (child) => {
        this.lateCreations.delete(cleanup);
        return this.disposeOwned(child, id);
      },
      () => {
        this.lateCreations.delete(cleanup);
        this.schedule();
      },
    );
    this.lateCreations.add(cleanup);
  }

  private disposeOwned(child: ChildSession, id: string): Promise<void> {
    const existing = this.childDisposals.get(child);
    if (existing) return existing;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve().then(() => this.shutdownSession(child));
    const disposal = Promise.race([
      operation.then(
        () => ({ type: "done" as const }),
        (error) => ({ type: "error" as const, error }),
      ),
      new Promise<{ type: "timeout" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ type: "timeout" }),
          DISPOSAL_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ])
      .then((result) => {
        if (result.type === "done") return;
        const evidence =
          result.type === "timeout"
            ? `timed out after ${DISPOSAL_TIMEOUT_MS}ms`
            : errorMessage(result.error).replace(/\s+/g, " ").slice(0, 512);
        console.error(`[delegate] cleanup failed for ${id}: ${evidence}`);
        try {
          child.dispose();
        } catch {
          // Local disposal is the final fallback after backend cleanup fails.
        }
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        this.disposals.delete(disposal);
        this.schedule();
      });
    this.childDisposals.set(child, disposal);
    this.disposals.add(disposal);
    return disposal;
  }
}
