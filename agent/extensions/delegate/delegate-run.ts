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
	shutdownChild,
} from "./runtime.ts";

const MAX_PENDING_SENDS = 8;
const DISPOSAL_TIMEOUT_MS = 16_000;
const MAX_CHECKPOINT_BYTES = 4 * 1024;
type UsageField =
	| "input"
	| "output"
	| "cacheRead"
	| "cacheWrite"
	| "totalTokens"
	| "cost";
const USAGE_FIELDS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"cost",
] satisfies readonly UsageField[];

export interface DelegateRunRequest {
	task: string;
	model?: string;
	effort?: string;
	outputFormat?: string;
	background?: boolean;
	cwd?: string;
	ctx: ExtensionContext;
}

export interface DelegateRunOptions {
	readonly id: string;
	readonly request: DelegateRunRequest & { cwd: string };
	readonly effort: DelegateEffort;
	readonly thinking: DelegateThinking;
	readonly requestedModel: string;
	readonly fallbackReason?: string;
	readonly modelChoice: ExtensionContext["model"];
	readonly createSession?: (
		request: DelegateRunRequest & { cwd: string },
		model: ExtensionContext["model"],
		thinking: DelegateThinking,
		signal: AbortSignal,
	) => Promise<ChildSession>;
	readonly shutdownSession?: (child: ChildSession) => Promise<void>;
	readonly nextSettlementOrder: () => number;
	readonly onStarted?: (snapshot: DelegateSnapshot) => void;
	readonly onSettlement?: (order: number, snapshot: DelegateSnapshot) => void;
	readonly onSettled?: (snapshot: DelegateSnapshot) => void;
	readonly notify: (snapshot: DelegateSnapshot) => void;
	readonly onDisposalStarted: (fiber: Fiber.Fiber<void, never>) => void;
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

export class DelegateRun {
	readonly id: string;
	private readonly request: DelegateRunRequest & { cwd: string };
	private readonly effort: DelegateEffort;
	private readonly thinking: DelegateThinking;
	private readonly requestedModel: string;
	private readonly fallbackReason?: string;
	private readonly modelChoice: ExtensionContext["model"];
	private readonly createSession?: DelegateRunOptions["createSession"];
	private readonly shutdownSession?: DelegateRunOptions["shutdownSession"];
	private readonly callbacks: Pick<
		DelegateRunOptions,
		| "nextSettlementOrder"
		| "onStarted"
		| "onSettlement"
		| "onSettled"
		| "notify"
		| "onDisposalStarted"
	>;
	private readonly createdAt = Effect.runSync(Clock.currentTimeMillis);
	private readonly childState = new ChildState();
	private readonly completion = Deferred.makeUnsafe<DelegateSnapshot>();
	private readonly ownership = new AbortController();
	private readonly sendSemaphore = Semaphore.makeUnsafe(1);
	private readonly state: RunState;
	private pendingSends = 0;
	private model?: string;
	private childSessionId?: string;
	private childSessionFile?: string;
	private disposal?: Fiber.Fiber<void, never>;

	constructor(options: DelegateRunOptions) {
		this.id = options.id;
		this.request = options.request;
		this.effort = options.effort;
		this.thinking = options.thinking;
		this.requestedModel = options.requestedModel;
		this.fallbackReason = options.fallbackReason;
		this.modelChoice = options.modelChoice;
		this.model = modelName(options.modelChoice);
		this.createSession = options.createSession;
		this.shutdownSession = options.shutdownSession;
		this.callbacks = options;
		const timer = scheduleTimer(
			() =>
				this.stopAtHardLimit(
					`${MAX_EXECUTION_MS / 60_000} minutes of wall time`,
				),
			MAX_EXECUTION_MS,
		);
		timer.unref?.();
		this.state = RunState.creating(timer, options.request.background === true);
	}

	status() {
		return this.state.status();
	}

	isActive() {
		return this.state.isActive();
	}

	trail() {
		return this.childState.trail();
	}

	consumeDelivery() {
		this.state.consumeDelivery();
	}

	awaitCompletion(): Effect.Effect<DelegateSnapshot> {
		return this.state.isActive()
			? Deferred.await(this.completion)
			: Effect.succeed(this.snapshot());
	}

	readonly execute = Effect.fn("DelegateRun.execute")(function* (
		this: DelegateRun,
	) {
		let receivedAssistantResponse = false;
		const createSession = this.createSession;
		const child = yield* createSession
			? Effect.tryPromise({
					try: () =>
						createSession(
							this.request,
							this.modelChoice,
							this.thinking,
							this.ownership.signal,
						),
					catch: delegateError,
				})
			: createChild(
					this.request.cwd,
					this.modelChoice,
					this.thinking,
					undefined,
					this.request.ctx.sessionManager,
				).pipe(Effect.mapError(delegateError));
		this.childSessionId = child.sessionManager.getSessionId();
		this.childSessionFile = child.sessionManager.getSessionFile();
		if (!this.state.isActive()) {
			yield* this.dispose(child);
			return;
		}
		this.callbacks.onStarted?.(this.snapshot());
		this.model = modelName(child.model ?? this.modelChoice);
		if (!this.state.startSubscribing(child)) {
			yield* this.dispose(child);
			return;
		}
		const unsubscribe = child.subscribe((event) => {
			if (isAssistantResponse(event)) receivedAssistantResponse = true;
			this.onEvent(event);
		});
		if (!this.state.startRunning(child, unsubscribe)) {
			unsubscribe();
			yield* this.dispose(child);
			return;
		}

		const outputFormat = this.request.outputFormat?.trim();
		const instruction = outputFormat
			? `${this.request.task}\n\nPreferred output format (advisory):\n${outputFormat}\n\nPrioritize correct and complete information over exact formatting.`
			: this.request.task;
		const promptOutcome = yield* this.untilOwnershipEnds(
			child
				.prompt(instruction, {
					expandPromptTemplates: false,
					source: "extension",
				})
				.then(() => child.waitForIdle()),
		).pipe(Effect.exit);
		if (promptOutcome._tag === "Failure") {
			this.settleError(errorMessage(Cause.squash(promptOutcome.cause)));
			return;
		}
		if (!receivedAssistantResponse) {
			this.settleError(
				`Delegate ${this.id} finished without an assistant response. Retry the delegation.`,
			);
			return;
		}
		if (!this.state.isRunning()) return;
		const childState = this.childState.state();
		if (childState.assistantStop === "error") {
			this.settleError(childState.assistantError ?? "Child agent failed.");
			return;
		}
		if (childState.assistantStop === "aborted") {
			this.settleCancelled(childState.assistantError ?? "Child agent aborted.");
			return;
		}
		this.settleDone();
	});

	readonly send = Effect.fn("DelegateRun.send")(function* (
		this: DelegateRun,
		message: string,
	) {
		const text = message.trim();
		if (!text) throw new Error("Delegate message must not be empty.");
		if (!this.state.isActive()) {
			throw new Error(
				`Delegate ${this.id} is ${this.state.status()}; send requires a running child.`,
			);
		}
		const child = this.state.runningChild();
		if (!child) throw new Error(`Delegate ${this.id} has no active session.`);
		if (this.pendingSends >= MAX_PENDING_SENDS) {
			throw new Error(
				`Delegate ${this.id} already has ${MAX_PENDING_SENDS} pending messages.`,
			);
		}
		this.pendingSends++;
		yield* this.sendSemaphore
			.withPermit(
				Effect.gen(
					function* (this: DelegateRun) {
						if (
							!this.state.ownsRunningChild(child) ||
							this.ownership.signal.aborted
						) {
							throw new Error(
								`Delegate ${this.id} settled before the queued message could be sent.`,
							);
						}
						yield* this.untilOwnershipEnds(child.steer(text));
					}.bind(this),
				),
			)
			.pipe(Effect.ensuring(Effect.sync(() => this.pendingSends--)));
		const snapshot = this.snapshot();
		this.callbacks.notify(snapshot);
		return snapshot;
	});

	stopForCancellation(): Effect.Effect<void> {
		return this.state.stopForCancellation(
			() => this.stop(),
			() =>
				this.endOwnership(new Error(`Delegate ${this.id} ownership ended.`)),
		);
	}

	settleExecutionError(error: string) {
		this.settleError(error);
	}

	cleanup() {
		this.childState.cleanup();
	}

	snapshot(): DelegateSnapshot {
		const child = this.state.runningChild();
		if (child) {
			this.childSessionFile = child.sessionManager.getSessionFile();
			this.childState.synchronizeUsage(child.sessionManager.getEntries());
		}
		const childState = this.childState.state();
		const state = this.state.view();
		const status = state.status;
		const settledAt = status === "running" ? undefined : state.settledAt;
		const error =
			status === "error" || status === "cancelled" ? state.error : undefined;
		const checkpoint =
			status === "error" || status === "cancelled"
				? state.checkpoint || undefined
				: undefined;
		return {
			id: this.id,
			status,
			createdAt: this.createdAt,
			settledAt,
			output: childState.output,
			outputTruncated: childState.outputTruncated,
			fullOutputFile: childState.fullOutputFile,
			childSessionId: this.childSessionId,
			childSessionFile: this.childSessionFile,
			success: status === "done",
			assignedTask: this.request.task,
			effort: this.effort,
			requestedModel: this.requestedModel,
			model: this.model,
			thinking: this.thinking,
			fallbackReason: this.fallbackReason,
			durationMs:
				(settledAt ?? Effect.runSync(Clock.currentTimeMillis)) - this.createdAt,
			toolCalls: childState.toolCalls,
			failedToolCalls: childState.failedToolCalls,
			childUsage: childState.usage,
			childUsageUnavailable: USAGE_FIELDS.filter(
				(field) => !childState.usageReported[field],
			),
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

	private onEvent(event: Parameters<ChildState["capture"]>[0]) {
		this.childState.capture(event);
		if (this.childState.state().usage.totalTokens >= MAX_EXECUTION_TOKENS) {
			this.stopAtHardLimit(
				`${MAX_EXECUTION_TOKENS.toLocaleString("en-US")} reported tokens`,
			);
		}
		this.callbacks.notify(this.snapshot());
	}

	private stopAtHardLimit(limit: string) {
		if (!this.state.isActive() || this.state.isStopping()) return;
		const error = `Delegation stopped at the hard execution ceiling: ${limit}.`;
		Effect.runFork(
			this.state.stopAtExecutionCeiling(
				error,
				() => this.stop(),
				() => this.endOwnership(new Error(error)),
			),
		);
	}

	private readonly stop = Effect.fn("DelegateRun.stop")(function* (
		this: DelegateRun,
	) {
		const child = this.state.stoppingChild();
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
					`[delegate] abort failed for ${this.id}: ${evidence}`,
				);
			}
			this.childState.synchronizeUsage(child.sessionManager.getEntries());
			if (
				(!stopped || child.isStreaming) &&
				this.state.releaseStoppingChild(child)
			) {
				yield* this.dispose(child);
			}
		}
		if (!this.state.isStopping()) return;
		const settledAt = yield* Clock.currentTimeMillis;
		const transition = this.publishSettlement((order) =>
			this.state.settleStopping(this.checkpoint(), settledAt, order),
		);
		if (transition.kind === "settled" && transition.child) {
			yield* this.dispose(transition.child);
		}
	});

	private checkpoint() {
		return truncateUtf8Tail(
			this.childState.trail().join("\n\n"),
			MAX_CHECKPOINT_BYTES,
		);
	}

	private settleDone() {
		const settledAt = Effect.runSync(Clock.currentTimeMillis);
		this.publishSettlement((order) => this.state.settleDone(settledAt, order));
	}

	private settleError(error: string) {
		const settledAt = Effect.runSync(Clock.currentTimeMillis);
		this.publishSettlement((order) =>
			this.state.settleError(error, this.checkpoint(), settledAt, order),
		);
	}

	private settleCancelled(error: string) {
		const settledAt = Effect.runSync(Clock.currentTimeMillis);
		this.publishSettlement((order) =>
			this.state.settleCancelled(error, this.checkpoint(), settledAt, order),
		);
	}

	private publishSettlement(
		transitionFor: (order: number) => SettlementTransition,
	) {
		const order = this.callbacks.nextSettlementOrder();
		const transition = transitionFor(order);
		if (transition.kind === "unchanged") return transition;
		this.endOwnership(new Error(`Delegate ${this.id} ownership ended.`));
		if (transition.child) {
			this.childState.synchronizeUsage(
				transition.child.sessionManager.getEntries(),
			);
		}
		const snapshot = this.snapshot();
		this.callbacks.onSettlement?.(order, snapshot);
		Effect.runSync(Deferred.succeed(this.completion, snapshot));
		this.callbacks.notify(snapshot);
		if (this.state.shouldDeliverSettlement())
			this.callbacks.onSettled?.(snapshot);
		if (transition.child) Effect.runFork(this.dispose(transition.child));
		return transition;
	}

	private endOwnership(reason: Error) {
		if (!this.ownership.signal.aborted) this.ownership.abort(reason);
	}

	private untilOwnershipEnds(operation: Promise<unknown>) {
		return Effect.tryPromise({
			try: () => operation,
			catch: delegateError,
		}).pipe(Effect.raceFirst(abortSignal(this.ownership.signal)));
	}

	private dispose(child: ChildSession): Effect.Effect<void> {
		if (this.disposal) return Fiber.join(this.disposal);
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
						`[delegate] cleanup failed for ${this.id}: ${evidence}`,
					).pipe(
						Effect.andThen(
							Effect.try(() => child.dispose()).pipe(Effect.ignore),
						),
					);
				}),
			),
		);
		this.disposal = disposal;
		this.callbacks.onDisposalStarted(disposal);
		return Fiber.join(disposal);
	}
}
