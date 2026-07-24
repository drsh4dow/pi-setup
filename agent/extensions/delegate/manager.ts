import type {
  AgentSessionEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  type DelegateEffort,
  type DelegateSnapshot,
  type DelegateStatus,
  type DelegateThinking,
  type DelegateUsageStats,
  type DelegateWorkspace,
  MAX_ACTIVE_CHILDREN,
  MAX_CHILD_OUTPUT_BYTES,
  MAX_PENDING_CHILDREN,
  MAX_RETAINED_SESSIONS,
  MAX_TRACKED_CHILDREN,
} from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { extractAssistantText } from "./output.ts";
import {
  type ChildSession,
  createChild,
  modelName,
  resolveDelegateModel,
  shutdownChild,
  thinkingForEffort,
} from "./runtime.ts";

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
  prompt: string;
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
  error?: string;
  assistantStop?: "error" | "aborted";
  assistantError?: string;
  output: string;
  toolCalls: number;
  failedToolCalls: number;
  usage: DelegateUsageStats;
  child?: ChildSession;
  unsubscribe?: () => void;
  run: number;
  stopping?: boolean;
  completion: Deferred;
  sendChain: Promise<void>;
  background: boolean;
  deliverRun: boolean;
}

export interface DelegateManagerOptions {
  createSession?: (
    request: DelegateRequest,
    model: ExtensionContext["model"],
    thinking: DelegateThinking,
    captureStructured: (value: unknown) => void,
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

function emptyUsage(): DelegateUsageStats {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function boundedOutput(text: string) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_CHILD_OUTPUT_BYTES) return text;
  return `${bytes.subarray(0, MAX_CHILD_OUTPUT_BYTES - 28).toString("utf8")}\n[child output truncated]`;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Operation aborted");
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
  private nextId = 0;
  private disposed = false;

  constructor(options: DelegateManagerOptions = {}) {
    this.createSession =
      options.createSession ??
      ((request, model, thinking, captureStructured) =>
        Effect.runPromise(
          createChild(request.ctx, model, thinking, {
            schema: request.schema,
            captureStructured,
          }),
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
      prompt: request.task,
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
      output: "",
      toolCalls: 0,
      failedToolCalls: 0,
      usage: emptyUsage(),
      run: 0,
      completion: deferred(),
      sendChain: Promise.resolve(),
      background: request.background === true,
      deliverRun: request.background === true,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job);
    this.schedule();
    const snapshot = this.snapshot(job);
    this.notify(snapshot);
    return snapshot;
  }

  list(ids?: readonly string[]): DelegateSnapshot[] {
    if (!ids) return [...this.jobs.values()].map((job) => this.snapshot(job));
    return [...new Set(ids)].map((id) => this.snapshot(this.requireJob(id)));
  }

  async wait(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<DelegateSnapshot[]> {
    const jobs = [...new Set(ids)].map((id) => this.requireJob(id));
    if (jobs.length === 0) throw new Error("Provide at least one delegate id.");
    for (const job of jobs) job.deliverRun = false;
    const completion = Promise.all(
      jobs.map((job) =>
        job.status === "queued" || job.status === "running"
          ? job.completion.promise
          : Promise.resolve(this.snapshot(job)),
      ),
    );
    if (!signal) return completion;
    if (signal.aborted) throw abortError(signal);
    return Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortError(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        void completion.finally(() =>
          signal.removeEventListener("abort", onAbort),
        );
      }),
    ]);
  }

  async send(id: string, message: string): Promise<DelegateSnapshot> {
    const job = this.requireJob(id);
    const text = message.trim();
    if (!text) throw new Error("Delegate message must not be empty.");
    if (job.status === "running") {
      if (!job.child) throw new Error(`Delegate ${id} has no active session.`);
      const child = job.child;
      const sending = job.sendChain.then(() => child.steer(text));
      job.sendChain = sending.catch(() => {});
      await sending;
      const snapshot = this.snapshot(job);
      this.notify(snapshot);
      return snapshot;
    }
    if (job.status === "queued") {
      throw new Error(`Delegate ${id} has not started yet.`);
    }
    if (!job.child) {
      throw new Error(
        `Delegate ${id} is no longer resumable; start a fresh child instead.`,
      );
    }
    if (this.pending.length >= MAX_PENDING_CHILDREN) {
      throw new Error(
        `Delegate queue is full (${MAX_PENDING_CHILDREN} pending children).`,
      );
    }

    job.prompt = text;
    job.status = "queued";
    job.settledAt = undefined;
    job.error = undefined;
    job.assistantStop = undefined;
    job.assistantError = undefined;
    job.output = "";
    job.structured = undefined;
    job.stopping = undefined;
    job.completion = deferred();
    job.deliverRun = job.background;
    this.pending.push(job);
    this.schedule();
    const snapshot = this.snapshot(job);
    this.notify(snapshot);
    return snapshot;
  }

  async cancel(ids: readonly string[]): Promise<DelegateSnapshot[]> {
    const jobs = [...new Set(ids)].map((id) => this.requireJob(id));
    for (const job of jobs) job.deliverRun = false;
    await Promise.all(jobs.map((job) => this.stop(job)));
    return jobs.map((job) => this.snapshot(job));
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const jobs = [...this.jobs.values()];
    await Promise.all(
      jobs.map((job) =>
        job.status === "queued" || job.status === "running"
          ? this.stop(job)
          : Promise.resolve(),
      ),
    );
    await Promise.all(
      jobs.map(async (job) => {
        if (!job.child) return;
        const child = job.child;
        job.child = undefined;
        job.unsubscribe?.();
        job.unsubscribe = undefined;
        await this.disposeSession(child);
      }),
    );
    await this.waitForRuns();
    this.pending.length = 0;
    this.active.clear();
  }

  private schedule() {
    if (this.disposed || this.pending.length === 0) return;
    while (this.pending.length > 0 && this.active.size < MAX_ACTIVE_CHILDREN) {
      const next = this.pending[0];
      if (!this.canRun(next)) return;
      this.pending.shift();
      this.active.add(next.id);
      next.status = "running";
      next.run++;
      this.notify(this.snapshot(next));
      const run = next.run;
      const task = this.run(next, run).catch((error) => {
        if (next.run === run && next.status === "running" && !next.stopping) {
          this.finalize(next, "error", errorMessage(error));
        }
      });
      this.runTasks.add(task);
      void task.finally(() => this.runTasks.delete(task));
    }
  }

  private canRun(job: Job): boolean {
    if (this.active.size === 0) return true;
    if (job.workspace === "write") return false;
    return ![...this.active].some(
      (id) => this.jobs.get(id)?.workspace === "write",
    );
  }

  private async run(job: Job, run: number) {
    if (!job.child) {
      const request: DelegateRequest = {
        task: job.task,
        effort: job.effort,
        workspace: job.workspace,
        schema: job.schema,
        background: job.background,
        ctx: job.ctx,
      };
      job.child = await this.createSession(
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
      );
      if (job.run !== run || job.status !== "running") {
        const child = job.child;
        job.child = undefined;
        await this.disposeSession(child);
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
          ? job.prompt
          : `${job.prompt}\n\nReturn the final result by calling structured_output exactly once as your final action. Do not write text after that call.`;
      await child.prompt(instruction, {
        expandPromptTemplates: false,
        source: "extension",
      });
      if (job.run !== run || job.status !== "running" || job.stopping) return;
      if (job.assistantStop === "error") {
        this.finalize(
          job,
          "error",
          job.assistantError ?? "Child agent failed.",
        );
        return;
      }
      if (job.assistantStop === "aborted") {
        this.finalize(
          job,
          "cancelled",
          job.assistantError ?? "Child agent aborted.",
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
      if (job.run !== run || job.status !== "running" || job.stopping) return;
      this.finalize(job, "error", errorMessage(error));
    }
  }

  private onEvent(job: Job, event: AgentSessionEvent) {
    if (event.type === "tool_execution_start") job.toolCalls++;
    if (event.type === "tool_execution_end" && event.isError) {
      job.failedToolCalls++;
    }
    this.notify(this.snapshot(job));
    if (event.type !== "message_end") return;
    const text = extractAssistantText(event.message);
    if (text) job.output = boundedOutput(text);
    if (event.message.role !== "assistant") return;
    if (
      event.message.stopReason === "error" ||
      event.message.stopReason === "aborted"
    ) {
      job.assistantStop = event.message.stopReason;
      job.assistantError = event.message.errorMessage;
    }
    const usage = event.message.usage;
    job.usage.turns++;
    job.usage.input += usage?.input ?? 0;
    job.usage.output += usage?.output ?? 0;
    job.usage.cacheRead += usage?.cacheRead ?? 0;
    job.usage.cacheWrite += usage?.cacheWrite ?? 0;
    job.usage.totalTokens += usage?.totalTokens ?? 0;
    job.usage.cost += usage?.cost?.total ?? 0;
    this.notify(this.snapshot(job));
  }

  private async stop(job: Job) {
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
      const stopped = await Promise.race([
        child.abort().then(
          () => true,
          () => false,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!stopped || child.isStreaming) {
        job.child = undefined;
        job.unsubscribe?.();
        job.unsubscribe = undefined;
        await this.disposeSession(child);
      }
    }
    if (job.status === "running") {
      this.finalize(job, "cancelled", "Delegation cancelled");
    }
  }

  private finalize(job: Job, status: DelegateStatus, error?: string) {
    job.status = status;
    job.settledAt = Date.now();
    job.error = error;
    job.stopping = undefined;
    this.active.delete(job.id);
    const snapshot = this.snapshot(job);
    job.completion.resolve(snapshot);
    this.notify(snapshot);
    if (job.deliverRun && job.background) this.onSettled?.(snapshot);
    job.deliverRun = false;
    void this.pruneSessions();
    this.pruneTracked();
    this.schedule();
  }

  private snapshot(job: Job): DelegateSnapshot {
    return {
      id: job.id,
      status: job.status,
      workspace: job.workspace,
      createdAt: job.createdAt,
      settledAt: job.settledAt,
      output: job.output,
      structured: job.structured,
      resumable: job.child !== undefined,
      success: job.status === "done",
      assignedTask: job.task,
      effort: job.effort,
      requestedModel: job.requestedModel,
      model: job.model,
      thinking: job.thinking,
      fallbackReason: job.fallbackReason,
      durationMs: (job.settledAt ?? Date.now()) - job.createdAt,
      toolCalls: job.toolCalls,
      failedToolCalls: job.failedToolCalls,
      childUsage: { ...job.usage },
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

  private async pruneSessions() {
    const retained = [...this.jobs.values()]
      .filter(
        (job) =>
          job.child && job.status !== "queued" && job.status !== "running",
      )
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    const excess = Math.max(0, retained.length - MAX_RETAINED_SESSIONS);
    for (const job of retained.slice(0, excess)) {
      const child = job.child;
      if (!child) continue;
      job.child = undefined;
      job.unsubscribe?.();
      job.unsubscribe = undefined;
      await this.disposeSession(child);
    }
  }

  private pruneTracked() {
    if (this.jobs.size < MAX_TRACKED_CHILDREN) return;
    const settled = [...this.jobs.values()]
      .filter((job) => job.status !== "queued" && job.status !== "running")
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    while (this.jobs.size >= MAX_TRACKED_CHILDREN && settled.length > 0) {
      const job = settled.shift();
      if (!job) break;
      this.jobs.delete(job.id);
      if (job.child) {
        const child = job.child;
        job.child = undefined;
        job.unsubscribe?.();
        void this.disposeSession(child);
      }
    }
  }

  private async waitForRuns() {
    if (this.runTasks.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.runTasks]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async disposeSession(child: ChildSession) {
    try {
      await this.shutdownSession(child);
    } catch {
      // The manager has relinquished the child even if backend cleanup fails.
    }
  }
}
