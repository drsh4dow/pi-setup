import type {
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { ChildState } from "./child-state.ts";
import type {
  DelegateEffort,
  DelegateSnapshot,
  DelegateStatus,
  DelegateThinking,
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
const DISPOSAL_TIMEOUT_MS = 16_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MINUTE_MS = 60_000;
const MAX_EXECUTION_MS = 60 * MINUTE_MS;
const MAX_EXECUTION_TOKENS = 60_000_000;
export const MAX_CONCURRENT_WAITS_PER_CHILD = 4;

export interface DelegateRequest {
  task: string;
  effort?: string;
  outputFormat?: string;
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
  outputFormat?: string;
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
  childState: ChildState;
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
  hardTimer?: ReturnType<typeof setTimeout>;
  hardLimitError?: string;
}

export interface DelegateManagerOptions {
  createSession?: (
    request: DelegateRequest,
    model: ExtensionContext["model"],
    thinking: DelegateThinking,
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

function isAssistantResponse(event: AgentSessionEvent) {
  return (
    (event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end") &&
    event.message.role === "assistant"
  );
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
  // The product contract deliberately admits every run immediately and retains it for the parent session; the user accepts unbounded aggregate use instead of backpressure or eviction.
  private readonly jobs = new Map<string, Job>();
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
      ((request, model, thinking, signal) =>
        Effect.runPromise(createChild(request.ctx, model, thinking), {
          signal,
        }));
    this.shutdownSession = options.shutdownSession ?? shutdownChild;
    this.onSettled = options.onSettled;
  }

  subscribe(listener: (snapshot: DelegateSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sessionUsage() {
    let tokens = 0;
    let cost = 0;
    for (const job of this.jobs.values()) {
      const usage = job.childState.state().usage;
      tokens += usage.totalTokens;
      cost += usage.cost;
    }
    return { tokens, cost };
  }

  spawn(request: DelegateRequest): DelegateSnapshot {
    if (this.disposed) throw new Error("Delegate manager is shutting down.");
    if (!request.task.trim())
      throw new Error("Delegated task must not be empty.");

    const modelChoice = resolveDelegateModel(request.ctx);
    const effort = request.effort === "thorough" ? "thorough" : "fast";
    const job: Job = {
      id: `delegate-${++this.nextId}`,
      task: request.task,
      effort,
      thinking: thinkingForEffort(effort),
      outputFormat: request.outputFormat,
      ctx: request.ctx,
      requestedModel: modelChoice.requestedModel,
      fallbackReason: modelChoice.fallbackReason,
      modelChoice: modelChoice.model,
      model: modelName(modelChoice.model),
      status: "running",
      createdAt: Date.now(),
      settlementOrder: 0,
      childState: new ChildState(),
      completion: deferred(),
      ownership: new AbortController(),
      sendChain: Promise.resolve(),
      pendingSends: 0,
      deliveryPending: request.background === true,
      deliveryWaiters: 0,
      waiters: 0,
    };
    this.jobs.set(job.id, job);
    this.startExecutionBudget(job);
    const snapshot = this.snapshot(job);
    this.notify(snapshot);
    const task = this.run(job).catch((error) => {
      if (job.status === "running" && !job.stopping) {
        this.finalize(job, "error", errorMessage(error));
      }
    });
    this.runTasks.add(task);
    void task.finally(() => this.runTasks.delete(task));
    return snapshot;
  }

  list(ids?: readonly string[]): DelegateSnapshot[] {
    if (ids) {
      return [...new Set(ids)].map((id) => this.snapshot(this.requireJob(id)));
    }
    return [...this.jobs.values()]
      .sort((a, b) => {
        const active = (job: Job) => (job.status === "running" ? 0 : 1);
        return active(a) - active(b) || b.settlementOrder - a.settlementOrder;
      })
      .map((job) => this.snapshot(job));
  }

  recentConversation(id: string): readonly string[] {
    return this.requireJob(id).childState.recentConversation();
  }

  latestProgress(id: string): string | undefined {
    return this.requireJob(id).childState.latestProgress();
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
        job.status === "running"
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
      job.status === "running" ? this.stopOwned(job) : Promise.resolve(),
    );
    await waitUntil(stopping, deadline);
    await waitUntil([...this.runTasks], deadline);
    await waitUntil([...this.lateCreations, ...this.disposals], deadline);
    for (const job of jobs) job.childState.cleanup();
  }

  private async run(job: Job) {
    let receivedAssistantResponse = false;
    if (!job.child) {
      const request: DelegateRequest = {
        task: job.task,
        effort: job.effort,
        outputFormat: job.outputFormat,
        ctx: job.ctx,
      };
      const signal = job.ownership.signal;
      const creation = this.createSession(
        request,
        job.modelChoice,
        job.thinking,
        signal,
      );
      let onEnded: (() => void) | undefined;
      try {
        job.child = await Promise.race([
          creation,
          new Promise<never>((_resolve, reject) => {
            onEnded = () => reject(abortError(signal));
            signal.addEventListener("abort", onEnded, { once: true });
          }),
        ]);
      } catch (error) {
        if (!signal.aborted) throw error;
        this.ownLateCreation(creation, job.id);
        return;
      } finally {
        if (onEnded) signal.removeEventListener("abort", onEnded);
      }
      if (job.status !== "running") {
        const child = job.child;
        job.child = undefined;
        await this.disposeOwned(child, job.id);
        return;
      }
      job.model = modelName(job.child.model ?? job.modelChoice);
      job.unsubscribe = job.child.subscribe((event) => {
        if (isAssistantResponse(event)) receivedAssistantResponse = true;
        this.onEvent(job, event);
      });
    }

    const child = job.child;
    try {
      const outputFormat = job.outputFormat?.trim();
      const instruction = outputFormat
        ? `${job.task}\n\nPreferred output format (advisory):\n${outputFormat}\n\nPrioritize correct and complete information over exact formatting.`
        : job.task;
      await this.untilOwnershipEnds(
        job,
        child.prompt(instruction, {
          expandPromptTemplates: false,
          source: "extension",
        }),
      );
      if (!receivedAssistantResponse) {
        throw new Error(
          `Delegate ${job.id} finished without an assistant response. Retry the delegation.`,
        );
      }
      if (job.status !== "running" || job.stopping) return;
      const childState = job.childState.state();
      if (childState.assistantStop === "error") {
        this.finalize(
          job,
          "error",
          childState.assistantError ?? "Child agent failed.",
        );
        return;
      }
      if (childState.assistantStop === "aborted") {
        this.finalize(
          job,
          "cancelled",
          childState.assistantError ?? "Child agent aborted.",
        );
        return;
      }
      this.finalize(job, "done");
    } catch (error) {
      if (job.status !== "running" || job.stopping) return;
      this.finalize(job, "error", errorMessage(error));
    }
  }

  private onEvent(job: Job, event: Parameters<ChildState["capture"]>[0]) {
    job.childState.capture(event);
    if (job.childState.state().usage.totalTokens >= MAX_EXECUTION_TOKENS) {
      this.stopAtHardLimit(
        job,
        `${MAX_EXECUTION_TOKENS.toLocaleString("en-US")} reported tokens`,
      );
    }
    this.notify(this.snapshot(job));
  }

  private startExecutionBudget(job: Job) {
    job.hardTimer = setTimeout(
      () =>
        this.stopAtHardLimit(
          job,
          `${MAX_EXECUTION_MS / MINUTE_MS} minutes of wall time`,
        ),
      MAX_EXECUTION_MS,
    );
    job.hardTimer.unref?.();
  }

  private stopAtHardLimit(job: Job, limit: string) {
    if (job.status !== "running" || job.stopping) return;
    job.hardLimitError = `Delegation stopped at the hard execution ceiling: ${limit}.`;
    void this.stopOwned(job);
  }

  private clearExecutionBudget(job: Job) {
    if (job.hardTimer !== undefined) clearTimeout(job.hardTimer);
    job.hardTimer = undefined;
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
    this.clearExecutionBudget(job);
    this.endOwnership(
      job,
      new Error(job.hardLimitError ?? `Delegate ${job.id} ownership ended.`),
    );
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
      this.finalize(
        job,
        job.hardLimitError ? "error" : "cancelled",
        job.hardLimitError ?? "Delegation cancelled",
      );
      if (child) await this.disposeOwned(child, job.id);
    }
  }

  private finalize(job: Job, status: DelegateStatus, error?: string) {
    this.clearExecutionBudget(job);
    this.endOwnership(job, new Error(`Delegate ${job.id} ownership ended.`));
    job.status = status;
    job.settledAt = Date.now();
    job.settlementOrder = ++this.nextSettlementOrder;
    job.error = error;
    job.stopping = undefined;
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
    if (this.disposed) job.childState.cleanup();
  }

  private snapshot(job: Job): DelegateSnapshot {
    const childState = job.childState.state();
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      settledAt: job.settledAt,
      output: childState.output,
      outputTruncated: childState.outputTruncated,
      fullOutputFile: childState.fullOutputFile,
      success: job.status === "done",
      assignedTask: job.task,
      effort: job.effort,
      requestedModel: job.requestedModel,
      model: job.model,
      thinking: job.thinking,
      fallbackReason: job.fallbackReason,
      durationMs: (job.settledAt ?? Date.now()) - job.createdAt,
      toolCalls: childState.toolCalls,
      failedToolCalls: childState.failedToolCalls,
      childUsage: childState.usage,
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

  private endOwnership(job: Job, reason: Error) {
    if (!job.ownership.signal.aborted) job.ownership.abort(reason);
  }

  private async steerOwned(job: Job, child: ChildSession, text: string) {
    await this.untilOwnershipEnds(job, child.steer(text));
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
      });
    this.childDisposals.set(child, disposal);
    this.disposals.add(disposal);
    return disposal;
  }
}
