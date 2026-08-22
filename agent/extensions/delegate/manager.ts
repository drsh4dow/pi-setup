const { statSync } = process.getBuiltinModule("fs");
const { resolve } = process.getBuiltinModule("path");

import type {
	AgentSessionEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Clock, Deferred, Effect, Fiber, Semaphore } from "effect";
import { truncateUtf8Tail } from "../../lib/text.ts";
import { ChildState } from "./child-state.ts";
import {
	type DelegateEffort,
	type DelegateSnapshot,
	type DelegateThinking,
	MAX_EXECUTION_MS,
	MAX_EXECUTION_TOKENS,
} from "./contract.ts";
import { delegateError, errorMessage } from "./errors.ts";
import { scheduleTimer } from "./host-timers.ts";
import { RunState, type SettlementTransition } from "./manager-state.ts";
import {
	type ChildSession,
	createChild,
	modelName,
	readProjectDelegateModelSetting,
	resolveDelegateModel,
	resolveRequestedModel,
	shutdownChild,
	thinkingForEffort,
} from "./runtime.ts";

const MAX_PENDING_SENDS = 8;
const DISPOSAL_TIMEOUT_MS = 16_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_CHECKPOINT_BYTES = 4 * 1024;
export const MAX_CONCURRENT_WAITS_PER_CHILD = 4;

export interface DelegateRequest {
	task: string;
	model?: string;
	effort?: string;
	outputFormat?: string;
	background?: boolean;
	cwd?: string;
	ctx: ExtensionContext;
}

interface Run {
	readonly id: string;
	readonly task: string;
	readonly cwd: string;
	readonly effort: DelegateEffort;
	readonly thinking: DelegateThinking;
	readonly outputFormat?: string;
	readonly ctx: ExtensionContext;
	readonly requestedModel: string;
	readonly fallbackReason?: string;
	readonly modelChoice: ExtensionContext["model"];
	model?: string;
	readonly createdAt: number;
	readonly childState: ChildState;
	readonly completion: Deferred.Deferred<DelegateSnapshot>;
	readonly ownership: AbortController;
	readonly sendSemaphore: Semaphore.Semaphore;
	pendingSends: number;
	waiters: number;
	readonly state: RunState;
}

export interface DelegateManagerOptions {
	createSession?: (
		request: DelegateRequest & { cwd: string },
		model: ExtensionContext["model"],
		thinking: DelegateThinking,
		signal: AbortSignal,
	) => Promise<ChildSession>;
	shutdownSession?: (child: ChildSession) => Promise<void>;
	onSettled?: (snapshot: DelegateSnapshot) => void;
}

function isDirectory(path: string) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Operation aborted");
}

function abortSignal(signal: AbortSignal) {
	if (signal.aborted) return Effect.fail(delegateError(abortError(signal)));
	return Effect.callback<never, ReturnType<typeof delegateError>>((resume) => {
		const onAbort = () =>
			resume(Effect.fail(delegateError(abortError(signal))));
		signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", onAbort));
	});
}

function isAssistantResponse(event: AgentSessionEvent) {
	return (
		(event.type === "message_start" ||
			event.type === "message_update" ||
			event.type === "message_end") &&
		event.message.role === "assistant"
	);
}

function waitUntil(
	effects: readonly Effect.Effect<unknown, unknown>[],
	deadline: number,
) {
	return Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		yield* Effect.all(effects.map(Effect.exit), {
			concurrency: "unbounded",
		}).pipe(Effect.timeoutOption(Math.max(0, deadline - now)), Effect.asVoid);
	});
}

export class DelegateManager {
	// The product contract deliberately admits every run immediately and retains it for the parent session; the user accepts unbounded aggregate use instead of backpressure or eviction.
	private readonly jobs = new Map<string, Run>();
	private readonly createSession?: DelegateManagerOptions["createSession"];
	private readonly shutdownSession?: DelegateManagerOptions["shutdownSession"];
	private readonly onSettled?: (snapshot: DelegateSnapshot) => void;
	private readonly listeners = new Set<(snapshot: DelegateSnapshot) => void>();
	private readonly runTasks = new Set<Fiber.Fiber<void, never>>();
	private readonly disposals = new Set<Fiber.Fiber<void, never>>();
	private readonly childDisposals = new WeakMap<
		object,
		Fiber.Fiber<void, never>
	>();
	private nextId = 0;
	private nextSettlementOrder = 0;
	private disposed: boolean = false;
	private shutdownEffect?: Effect.Effect<void>;

	constructor(options: DelegateManagerOptions = {}) {
		this.createSession = options.createSession;
		this.shutdownSession = options.shutdownSession;
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
		const cwd = resolve(request.ctx.cwd, request.cwd ?? ".");
		if (request.cwd !== undefined && !isDirectory(cwd)) {
			throw new Error(`Delegate cwd is not a directory: ${cwd}`);
		}

		const modelChoice =
			request.model !== undefined
				? resolveRequestedModel(request.ctx, request.model)
				: resolveDelegateModel(
						request.ctx,
						readProjectDelegateModelSetting(cwd, {
							parentCwd: request.ctx.cwd,
						}),
					);
		const effort = request.effort === "thorough" ? "thorough" : "fast";
		let job: Run;
		const timer = scheduleTimer(
			() =>
				this.stopAtHardLimit(
					job,
					`${MAX_EXECUTION_MS / 60_000} minutes of wall time`,
				),
			MAX_EXECUTION_MS,
		);
		timer.unref?.();
		job = {
			id: `delegate-${++this.nextId}`,
			task: request.task,
			cwd,
			effort,
			thinking: thinkingForEffort(effort),
			outputFormat: request.outputFormat,
			ctx: request.ctx,
			requestedModel: modelChoice.requestedModel,
			fallbackReason: modelChoice.fallbackReason,
			modelChoice: modelChoice.model,
			model: modelName(modelChoice.model),
			createdAt: Effect.runSync(Clock.currentTimeMillis),
			childState: new ChildState(),
			completion: Deferred.makeUnsafe(),
			ownership: new AbortController(),
			sendSemaphore: Semaphore.makeUnsafe(1),
			pendingSends: 0,
			waiters: 0,
			state: RunState.creating(timer, request.background === true),
		};
		this.jobs.set(job.id, job);
		const snapshot = this.snapshot(job);
		this.notify(snapshot);
		const task = Effect.runFork(
			this.run(job).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						this.settleError(job, errorMessage(Cause.squash(cause)));
					}),
				),
			),
		);
		this.runTasks.add(task);
		task.addObserver(() => this.runTasks.delete(task));
		return snapshot;
	}

	list(ids?: readonly string[]): DelegateSnapshot[] {
		if (ids) {
			return [...new Set(ids)].map((id) => this.snapshot(this.requireJob(id)));
		}
		return [...this.jobs.values()]
			.sort(
				(a, b) =>
					Number(!a.state.isActive()) - Number(!b.state.isActive()) ||
					b.state.settlementOrder() - a.state.settlementOrder(),
			)
			.map((job) => this.snapshot(job));
	}

	trail(id: string): readonly string[] {
		return this.requireJob(id).childState.trail();
	}

	readonly wait = Effect.fn("DelegateManager.wait")(function* (
		this: DelegateManager,
		ids: readonly string[],
		signal?: AbortSignal,
	) {
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
		const claims = jobs.filter((job) => job.state.claimDelivery());
		let completed = false;
		return yield* Effect.all(
			jobs.map((job) =>
				job.state.isActive()
					? Deferred.await(job.completion)
					: Effect.succeed(this.snapshot(job)),
			),
			{ concurrency: "unbounded" },
		).pipe(
			signal ? Effect.raceFirst(abortSignal(signal)) : (effect) => effect,
			Effect.flatMap((snapshots) =>
				signal?.aborted
					? Effect.fail(delegateError(abortError(signal)))
					: Effect.succeed(snapshots),
			),
			Effect.tap((snapshots) =>
				Effect.sync(() => {
					completed = true;
					for (const job of claims) job.state.consumeClaimedDelivery();
					return snapshots;
				}),
			),
			Effect.ensuring(
				Effect.sync(() => {
					for (const job of jobs) job.waiters--;
					for (const job of claims) {
						if (!completed && job.state.releaseDeliveryClaim()) {
							this.onSettled?.(this.snapshot(job));
						}
					}
				}),
			),
		);
	});

	readonly send = Effect.fn("DelegateManager.send")(function* (
		this: DelegateManager,
		id: string,
		message: string,
	) {
		const job = this.requireJob(id);
		const text = message.trim();
		if (!text) throw new Error("Delegate message must not be empty.");
		if (!job.state.isActive()) {
			throw new Error(
				`Delegate ${id} is ${job.state.status()}; send requires a running child.`,
			);
		}
		const child = job.state.runningChild();
		if (!child) throw new Error(`Delegate ${id} has no active session.`);
		if (job.pendingSends >= MAX_PENDING_SENDS) {
			throw new Error(
				`Delegate ${id} already has ${MAX_PENDING_SENDS} pending messages.`,
			);
		}
		job.pendingSends++;
		yield* job.sendSemaphore
			.withPermit(
				Effect.gen(
					function* (this: DelegateManager) {
						if (
							!job.state.ownsRunningChild(child) ||
							job.ownership.signal.aborted
						) {
							throw new Error(
								`Delegate ${id} settled before the queued message could be sent.`,
							);
						}
						yield* this.untilOwnershipEnds(job, child.steer(text));
					}.bind(this),
				),
			)
			.pipe(Effect.ensuring(Effect.sync(() => job.pendingSends--)));
		const snapshot = this.snapshot(job);
		this.notify(snapshot);
		return snapshot;
	});

	readonly cancel = Effect.fn("DelegateManager.cancel")(function* (
		this: DelegateManager,
		ids: readonly string[],
	) {
		const jobs = [...new Set(ids)].map((id) => this.requireJob(id));
		for (const job of jobs) job.state.consumePendingDelivery();
		yield* Effect.all(
			jobs.map((job) => this.stopOwned(job)),
			{
				concurrency: "unbounded",
			},
		);
		return jobs.map((job) => this.snapshot(job));
	});

	acknowledge(ids: readonly string[]) {
		for (const id of new Set(ids)) {
			this.jobs.get(id)?.state.consumePendingDelivery();
		}
	}

	shutdown(): Effect.Effect<void> {
		if (this.shutdownEffect) return this.shutdownEffect;
		this.disposed = true;
		this.shutdownEffect = Effect.runSync(Effect.cached(this.shutdownOwned()));
		return this.shutdownEffect;
	}

	private readonly shutdownOwned = Effect.fn("DelegateManager.shutdownOwned")(
		function* (this: DelegateManager) {
			const deadline = (yield* Clock.currentTimeMillis) + SHUTDOWN_TIMEOUT_MS;
			const jobs = [...this.jobs.values()];
			yield* waitUntil(
				jobs.map((job) =>
					job.state.isActive() ? this.stopOwned(job) : Effect.void,
				),
				deadline,
			);
			yield* waitUntil([...this.runTasks].map(Fiber.await), deadline);
			yield* waitUntil([...this.disposals].map(Fiber.await), deadline);
			for (const job of jobs) job.childState.cleanup();
		},
	);

	private readonly run = Effect.fn("DelegateManager.run")(function* (
		this: DelegateManager,
		job: Run,
	) {
		let receivedAssistantResponse = false;
		const request = {
			task: job.task,
			cwd: job.cwd,
			effort: job.effort,
			outputFormat: job.outputFormat,
			ctx: job.ctx,
		};
		const createSession = this.createSession;
		const child = yield* createSession
			? Effect.tryPromise({
					try: () =>
						createSession(
							request,
							job.modelChoice,
							job.thinking,
							job.ownership.signal,
						),
					catch: delegateError,
				})
			: createChild(request.cwd, job.modelChoice, job.thinking).pipe(
					Effect.mapError(delegateError),
				);
		if (!job.state.isActive()) {
			yield* this.disposeOwned(child, job.id);
			return;
		}
		job.model = modelName(child.model ?? job.modelChoice);
		if (!job.state.startSubscribing(child)) {
			yield* this.disposeOwned(child, job.id);
			return;
		}
		const unsubscribe = child.subscribe((event) => {
			if (isAssistantResponse(event)) receivedAssistantResponse = true;
			this.onEvent(job, event);
		});
		if (!job.state.startRunning(child, unsubscribe)) {
			unsubscribe();
			yield* this.disposeOwned(child, job.id);
			return;
		}

		const outputFormat = job.outputFormat?.trim();
		const instruction = outputFormat
			? `${job.task}\n\nPreferred output format (advisory):\n${outputFormat}\n\nPrioritize correct and complete information over exact formatting.`
			: job.task;
		const promptOutcome = yield* this.untilOwnershipEnds(
			job,
			child.prompt(instruction, {
				expandPromptTemplates: false,
				source: "extension",
			}),
		).pipe(Effect.exit);
		if (promptOutcome._tag === "Failure") {
			this.settleError(job, errorMessage(Cause.squash(promptOutcome.cause)));
			return;
		}
		if (!receivedAssistantResponse) {
			this.settleError(
				job,
				`Delegate ${job.id} finished without an assistant response. Retry the delegation.`,
			);
			return;
		}
		if (!job.state.isRunning()) return;
		const childState = job.childState.state();
		if (childState.assistantStop === "error") {
			this.settleError(job, childState.assistantError ?? "Child agent failed.");
			return;
		}
		if (childState.assistantStop === "aborted") {
			this.settleCancelled(
				job,
				childState.assistantError ?? "Child agent aborted.",
			);
			return;
		}
		this.settleDone(job);
	});

	private onEvent(job: Run, event: Parameters<ChildState["capture"]>[0]) {
		job.childState.capture(event);
		if (job.childState.state().usage.totalTokens >= MAX_EXECUTION_TOKENS) {
			this.stopAtHardLimit(
				job,
				`${MAX_EXECUTION_TOKENS.toLocaleString("en-US")} reported tokens`,
			);
		}
		this.notify(this.snapshot(job));
	}

	private stopAtHardLimit(job: Run, limit: string) {
		if (!job.state.isActive() || job.state.isStopping()) return;
		const error = `Delegation stopped at the hard execution ceiling: ${limit}.`;
		Effect.runFork(this.stopOwnedAtExecutionCeiling(job, error));
	}

	// RunState starts one root stop fiber. Interrupted observers, including an
	// aborted cancel or shutdown deadline, only join it and cannot poison it.
	private stopOwned(job: Run): Effect.Effect<void> {
		return job.state.stopForCancellation(
			() => this.stop(job),
			() =>
				this.endOwnership(
					job,
					new Error(`Delegate ${job.id} ownership ended.`),
				),
		);
	}

	private stopOwnedAtExecutionCeiling(
		job: Run,
		error: string,
	): Effect.Effect<void> {
		return job.state.stopAtExecutionCeiling(
			error,
			() => this.stop(job),
			() => this.endOwnership(job, new Error(error)),
		);
	}

	private readonly stop = Effect.fn("DelegateManager.stop")(function* (
		this: DelegateManager,
		job: Run,
	) {
		const child = job.state.stoppingChild();
		if (child) {
			let abortFailure: unknown;
			const stopped = yield* Effect.tryPromise({
				try: () => child.abort(),
				catch: delegateError,
			}).pipe(
				Effect.as(true),
				Effect.catch((error) => {
					abortFailure = error;
					return Effect.succeed(false);
				}),
				Effect.timeoutOrElse({
					duration: 5_000,
					orElse: () => Effect.succeed(false),
				}),
			);
			if (!stopped) {
				const evidence =
					abortFailure !== undefined
						? errorMessage(abortFailure).replace(/\s+/g, " ").slice(0, 512)
						: "timed out after 5000ms";
				yield* Effect.logError(
					`[delegate] abort failed for ${job.id}: ${evidence}`,
				);
			}
			if (
				(!stopped || child.isStreaming) &&
				job.state.releaseStoppingChild(child)
			) {
				yield* this.disposeOwned(child, job.id);
			}
		}
		if (!job.state.isStopping()) return;
		const settledAt = yield* Clock.currentTimeMillis;
		const settlementOrder = this.nextSettlementOrder + 1;
		const transition = job.state.settleStopping(
			this.checkpoint(job),
			settledAt,
			settlementOrder,
		);
		this.publishSettlement(job, settlementOrder, transition);
		if (transition.kind === "settled" && transition.child) {
			yield* this.disposeOwned(transition.child, job.id);
		}
	});

	private checkpoint(job: Run) {
		return truncateUtf8Tail(
			job.childState.trail().join("\n\n"),
			MAX_CHECKPOINT_BYTES,
		);
	}

	private settleDone(job: Run) {
		const settlementOrder = this.nextSettlementOrder + 1;
		this.publishSettlement(
			job,
			settlementOrder,
			job.state.settleDone(
				Effect.runSync(Clock.currentTimeMillis),
				settlementOrder,
			),
		);
	}

	private settleError(job: Run, error: string) {
		const settlementOrder = this.nextSettlementOrder + 1;
		this.publishSettlement(
			job,
			settlementOrder,
			job.state.settleError(
				error,
				this.checkpoint(job),
				Effect.runSync(Clock.currentTimeMillis),
				settlementOrder,
			),
		);
	}

	private settleCancelled(job: Run, error: string) {
		const settlementOrder = this.nextSettlementOrder + 1;
		this.publishSettlement(
			job,
			settlementOrder,
			job.state.settleCancelled(
				error,
				this.checkpoint(job),
				Effect.runSync(Clock.currentTimeMillis),
				settlementOrder,
			),
		);
	}

	private publishSettlement(
		job: Run,
		settlementOrder: number,
		transition: SettlementTransition,
	) {
		if (transition.kind === "unchanged") return;
		this.nextSettlementOrder = settlementOrder;
		this.endOwnership(job, new Error(`Delegate ${job.id} ownership ended.`));
		const snapshot = this.snapshot(job);
		Effect.runSync(Deferred.succeed(job.completion, snapshot));
		this.notify(snapshot);
		if (job.state.shouldDeliverSettlement()) this.onSettled?.(snapshot);
		if (transition.child) {
			Effect.runFork(this.disposeOwned(transition.child, job.id));
		}
		if (this.disposed) job.childState.cleanup();
	}

	private snapshot(job: Run): DelegateSnapshot {
		const childState = job.childState.state();
		const state = job.state.view();
		const status = state.status;
		const settledAt = status === "running" ? undefined : state.settledAt;
		const error =
			status === "error" || status === "cancelled" ? state.error : undefined;
		const checkpoint =
			status === "error" || status === "cancelled"
				? state.checkpoint || undefined
				: undefined;
		return {
			id: job.id,
			status,
			createdAt: job.createdAt,
			settledAt,
			output: childState.output,
			outputTruncated: childState.outputTruncated,
			fullOutputFile: childState.fullOutputFile,
			success: status === "done",
			assignedTask: job.task,
			effort: job.effort,
			requestedModel: job.requestedModel,
			model: job.model,
			thinking: job.thinking,
			fallbackReason: job.fallbackReason,
			durationMs:
				(settledAt ?? Effect.runSync(Clock.currentTimeMillis)) - job.createdAt,
			toolCalls: childState.toolCalls,
			failedToolCalls: childState.failedToolCalls,
			childUsage: childState.usage,
			aborted: status === "cancelled",
			error,
			progress: status === "running" ? childState.progress : undefined,
			idleMs:
				status === "running"
					? Effect.runSync(Clock.currentTimeMillis) - childState.lastActivityAt
					: undefined,
			checkpoint,
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

	private requireJob(id: string): Run {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown delegate id "${id}".`);
		return job;
	}

	private endOwnership(job: Run, reason: Error) {
		if (!job.ownership.signal.aborted) job.ownership.abort(reason);
	}

	private untilOwnershipEnds(job: Run, operation: Promise<unknown>) {
		return Effect.tryPromise({
			try: () => operation,
			catch: delegateError,
		}).pipe(Effect.raceFirst(abortSignal(job.ownership.signal)));
	}

	private disposeOwned(child: ChildSession, id: string): Effect.Effect<void> {
		const existing = this.childDisposals.get(child);
		if (existing) return Fiber.join(existing);
		const shutdownSession = this.shutdownSession;
		const shutdown = shutdownSession
			? Effect.tryPromise({
					try: () => shutdownSession(child),
					catch: delegateError,
				})
			: shutdownChild(child).pipe(Effect.mapError(delegateError));
		const disposal = Effect.runFork(
			shutdown.pipe(
				Effect.as({ type: "done" as const }),
				Effect.catch((error) =>
					Effect.succeed({ type: "error" as const, error }),
				),
				Effect.timeoutOrElse({
					duration: DISPOSAL_TIMEOUT_MS,
					orElse: () => Effect.succeed({ type: "timeout" as const }),
				}),
				Effect.flatMap((result) => {
					if (result.type === "done") return Effect.void;
					const evidence =
						result.type === "timeout"
							? `timed out after ${DISPOSAL_TIMEOUT_MS}ms`
							: errorMessage(result.error).replace(/\s+/g, " ").slice(0, 512);
					return Effect.logError(
						`[delegate] cleanup failed for ${id}: ${evidence}`,
					).pipe(
						Effect.andThen(
							Effect.try(() => child.dispose()).pipe(Effect.ignore),
						),
					);
				}),
			),
		);
		this.childDisposals.set(child, disposal);
		this.disposals.add(disposal);
		disposal.addObserver(() => this.disposals.delete(disposal));
		return Fiber.join(disposal);
	}
}
