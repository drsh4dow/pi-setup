import { Deferred, Effect, Fiber } from "effect";
import type { DelegateStatus } from "./contract.ts";
import { cancelTimer, type scheduleTimer } from "./host-timers.ts";
import type { ChildSession } from "./runtime.ts";

type ExecutionTimer = ReturnType<typeof scheduleTimer>;

type SubscribingChild = {
	readonly child: ChildSession;
};

type OwnedChild = SubscribingChild & {
	readonly unsubscribe: () => void;
};

type StoppingOwnership =
	| { readonly kind: "subscribing"; readonly child: ChildSession }
	| ({ readonly kind: "running" } & OwnedChild);

type StopReason =
	| { readonly kind: "cancel" }
	| { readonly kind: "execution-ceiling"; readonly error: string };

type SettledOutcome =
	| { readonly kind: "done" }
	| {
			readonly kind: "error";
			readonly error: string;
			readonly checkpoint: string;
	  }
	| {
			readonly kind: "cancelled";
			readonly error: string;
			readonly checkpoint: string;
	  };

type RunLifecycle =
	| { readonly kind: "creating"; readonly timer: ExecutionTimer }
	| {
			readonly kind: "subscribing";
			readonly ownership: SubscribingChild;
			readonly timer: ExecutionTimer;
	  }
	| {
			readonly kind: "running";
			readonly ownership: OwnedChild;
			readonly timer: ExecutionTimer;
	  }
	| {
			readonly kind: "stopping";
			readonly task: Fiber.Fiber<void>;
			readonly reason: StopReason;
			readonly ownership?: StoppingOwnership;
	  }
	| {
			readonly kind: "settled";
			readonly settledAt: number;
			readonly settlementOrder: number;
			readonly outcome: SettledOutcome;
	  };

type Delivery =
	| { readonly kind: "foreground" }
	| { readonly kind: "pending"; readonly waiters: number }
	| { readonly kind: "consumed" };

export type RunStateView =
	| { readonly status: "running" }
	| {
			readonly status: "done";
			readonly settledAt: number;
			readonly settlementOrder: number;
	  }
	| {
			readonly status: "error" | "cancelled";
			readonly settledAt: number;
			readonly settlementOrder: number;
			readonly error: string;
			readonly checkpoint: string;
	  };

export type SettlementTransition =
	| { readonly kind: "unchanged" }
	| { readonly kind: "settled"; readonly child?: ChildSession };

function assertNever(value: never): never {
	throw new Error(`Unhandled delegate state: ${String(value)}`);
}

export class RunState {
	private lifecycle: RunLifecycle;
	private delivery: Delivery;

	private constructor(lifecycle: RunLifecycle, delivery: Delivery) {
		this.lifecycle = lifecycle;
		this.delivery = delivery;
	}

	static creating(timer: ExecutionTimer, background: boolean): RunState {
		return new RunState(
			{ kind: "creating", timer },
			background ? { kind: "pending", waiters: 0 } : { kind: "foreground" },
		);
	}

	view(): RunStateView {
		const lifecycle = this.lifecycle;
		switch (lifecycle.kind) {
			case "creating":
			case "subscribing":
			case "running":
			case "stopping":
				return { status: "running" };
			case "settled":
				switch (lifecycle.outcome.kind) {
					case "done":
						return {
							status: "done",
							settledAt: lifecycle.settledAt,
							settlementOrder: lifecycle.settlementOrder,
						};
					case "error":
					case "cancelled":
						return {
							status: lifecycle.outcome.kind,
							settledAt: lifecycle.settledAt,
							settlementOrder: lifecycle.settlementOrder,
							error: lifecycle.outcome.error,
							checkpoint: lifecycle.outcome.checkpoint,
						};
					default:
						return assertNever(lifecycle.outcome);
				}
			default:
				return assertNever(lifecycle);
		}
	}

	status(): DelegateStatus {
		return this.view().status;
	}

	isActive(): boolean {
		return this.lifecycle.kind !== "settled";
	}

	settlementOrder(): number {
		const view = this.view();
		return view.status === "running" ? 0 : view.settlementOrder;
	}

	startSubscribing(child: ChildSession): boolean {
		const lifecycle = this.lifecycle;
		if (lifecycle.kind !== "creating") return false;
		this.lifecycle = {
			kind: "subscribing",
			ownership: { child },
			timer: lifecycle.timer,
		};
		return true;
	}

	startRunning(child: ChildSession, unsubscribe: () => void): boolean {
		const lifecycle = this.lifecycle;
		if (lifecycle.kind !== "subscribing" || lifecycle.ownership.child !== child)
			return false;
		this.lifecycle = {
			kind: "running",
			ownership: { child, unsubscribe },
			timer: lifecycle.timer,
		};
		return true;
	}

	runningChild(): ChildSession | undefined {
		return this.lifecycle.kind === "running"
			? this.lifecycle.ownership.child
			: undefined;
	}

	ownsRunningChild(child: ChildSession): boolean {
		return (
			this.lifecycle.kind === "running" &&
			this.lifecycle.ownership.child === child
		);
	}

	isRunning(): boolean {
		return this.lifecycle.kind === "running";
	}

	isStopping(): boolean {
		return this.lifecycle.kind === "stopping";
	}

	stopForCancellation(
		stop: () => Effect.Effect<void>,
		onStarted: () => void,
	): Effect.Effect<void> {
		return this.stop({ kind: "cancel" }, stop, onStarted);
	}

	stopAtExecutionCeiling(
		error: string,
		stop: () => Effect.Effect<void>,
		onStarted: () => void,
	): Effect.Effect<void> {
		return this.stop({ kind: "execution-ceiling", error }, stop, onStarted);
	}

	stoppingChild(): ChildSession | undefined {
		return this.lifecycle.kind === "stopping"
			? this.lifecycle.ownership?.child
			: undefined;
	}

	releaseStoppingChild(child: ChildSession): boolean {
		const lifecycle = this.lifecycle;
		if (lifecycle.kind !== "stopping" || lifecycle.ownership?.child !== child) {
			return false;
		}
		if (lifecycle.ownership.kind === "running") {
			lifecycle.ownership.unsubscribe();
		}
		this.lifecycle = {
			kind: "stopping",
			task: lifecycle.task,
			reason: lifecycle.reason,
		};
		return true;
	}

	settleDone(settledAt: number, settlementOrder: number): SettlementTransition {
		if (this.lifecycle.kind !== "running") return { kind: "unchanged" };
		return this.settle(
			settledAt,
			settlementOrder,
			{ kind: "done" },
			this.lifecycle.ownership,
			this.lifecycle.timer,
		);
	}

	settleError(
		error: string,
		checkpoint: string,
		settledAt: number,
		settlementOrder: number,
	): SettlementTransition {
		const lifecycle = this.lifecycle;
		if (lifecycle.kind === "creating") {
			return this.settle(
				settledAt,
				settlementOrder,
				{ kind: "error", error, checkpoint },
				undefined,
				lifecycle.timer,
			);
		}
		if (lifecycle.kind === "subscribing" || lifecycle.kind === "running") {
			return this.settle(
				settledAt,
				settlementOrder,
				{ kind: "error", error, checkpoint },
				lifecycle.ownership,
				lifecycle.timer,
			);
		}
		return { kind: "unchanged" };
	}

	settleCancelled(
		error: string,
		checkpoint: string,
		settledAt: number,
		settlementOrder: number,
	): SettlementTransition {
		if (this.lifecycle.kind !== "running") return { kind: "unchanged" };
		return this.settle(
			settledAt,
			settlementOrder,
			{ kind: "cancelled", error, checkpoint },
			this.lifecycle.ownership,
			this.lifecycle.timer,
		);
	}

	settleStopping(
		checkpoint: string,
		settledAt: number,
		settlementOrder: number,
	): SettlementTransition {
		const lifecycle = this.lifecycle;
		if (lifecycle.kind !== "stopping") return { kind: "unchanged" };
		const outcome: SettledOutcome =
			lifecycle.reason.kind === "execution-ceiling"
				? {
						kind: "error",
						error: lifecycle.reason.error,
						checkpoint,
					}
				: {
						kind: "cancelled",
						error: "Delegation cancelled",
						checkpoint,
					};
		return this.settle(
			settledAt,
			settlementOrder,
			outcome,
			lifecycle.ownership,
		);
	}

	claimDelivery(): boolean {
		if (this.delivery.kind !== "pending") return false;
		this.delivery = {
			kind: "pending",
			waiters: this.delivery.waiters + 1,
		};
		return true;
	}

	releaseDeliveryClaim(): boolean {
		if (this.delivery.kind !== "pending" || this.delivery.waiters === 0) {
			return false;
		}
		const waiters = this.delivery.waiters - 1;
		this.delivery = { kind: "pending", waiters };
		return waiters === 0 && this.lifecycle.kind === "settled";
	}

	consumeDelivery(): void {
		if (this.delivery.kind === "pending") {
			this.delivery = { kind: "consumed" };
		}
	}

	shouldDeliverSettlement(): boolean {
		return this.delivery.kind === "pending" && this.delivery.waiters === 0;
	}

	private stop(
		reason: StopReason,
		stop: () => Effect.Effect<void>,
		onStarted: () => void,
	): Effect.Effect<void> {
		return Effect.suspend(() => {
			const lifecycle = this.lifecycle;
			if (lifecycle.kind === "settled") return Effect.void;
			if (lifecycle.kind === "stopping") return Fiber.join(lifecycle.task);

			cancelTimer(lifecycle.timer);
			const start = Deferred.makeUnsafe<void>();
			const task = Effect.runFork(
				Deferred.await(start).pipe(Effect.andThen(stop())),
			);
			this.lifecycle = {
				kind: "stopping",
				task,
				reason,
				ownership:
					lifecycle.kind === "running"
						? { kind: "running", ...lifecycle.ownership }
						: lifecycle.kind === "subscribing"
							? { kind: "subscribing", ...lifecycle.ownership }
							: undefined,
			};
			onStarted();
			Effect.runSync(Deferred.succeed(start, undefined));
			return Fiber.join(task);
		});
	}

	private settle(
		settledAt: number,
		settlementOrder: number,
		outcome: SettledOutcome,
		ownership?: SubscribingChild | OwnedChild | StoppingOwnership,
		timer?: ExecutionTimer,
	): SettlementTransition {
		if (timer !== undefined) cancelTimer(timer);
		this.lifecycle = {
			kind: "settled",
			settledAt,
			settlementOrder,
			outcome,
		};
		if (ownership && "unsubscribe" in ownership) ownership.unsubscribe();
		return { kind: "settled", child: ownership?.child };
	}
}
