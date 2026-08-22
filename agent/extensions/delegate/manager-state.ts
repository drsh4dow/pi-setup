import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Deferred, Fiber, Semaphore } from "effect";
import type { ChildState } from "./child-state.ts";
import type {
	DelegateEffort,
	DelegateSnapshot,
	DelegateStatus,
	DelegateThinking,
} from "./contract.ts";
import type { scheduleTimer } from "./host-timers.ts";
import type { ChildSession } from "./runtime.ts";

type ExecutionTimer = ReturnType<typeof scheduleTimer>;

export type OwnedChild = {
	readonly kind: "owned";
	readonly child: ChildSession;
	readonly unsubscribe: () => void;
};

export type StoppingChild = { readonly kind: "none" } | OwnedChild;

export type StopReason =
	| { readonly kind: "cancel" }
	| { readonly kind: "execution-ceiling"; readonly error: string };

export type SettledOutcome =
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

export type RunLifecycle =
	| { readonly kind: "creating"; readonly timer: ExecutionTimer }
	| {
			readonly kind: "running";
			readonly child: ChildSession;
			readonly unsubscribe: () => void;
			readonly timer: ExecutionTimer;
	  }
	| {
			readonly kind: "stopping";
			readonly task: Fiber.Fiber<void>;
			readonly reason: StopReason;
			readonly child: StoppingChild;
	  }
	| {
			readonly kind: "settled";
			readonly settledAt: number;
			readonly settlementOrder: number;
			readonly outcome: SettledOutcome;
	  };

export type Delivery =
	| { readonly kind: "foreground" }
	| { readonly kind: "pending"; readonly waiters: number }
	| { readonly kind: "consumed" };

export interface Run {
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
	delivery: Delivery;
	lifecycle: RunLifecycle;
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled delegate state: ${String(value)}`);
}

export function lifecycleStatus(lifecycle: RunLifecycle): DelegateStatus {
	switch (lifecycle.kind) {
		case "creating":
		case "running":
		case "stopping":
			return "running";
		case "settled":
			return lifecycle.outcome.kind;
		default:
			return assertNever(lifecycle);
	}
}

export function isActive(lifecycle: RunLifecycle): boolean {
	switch (lifecycle.kind) {
		case "creating":
		case "running":
		case "stopping":
			return true;
		case "settled":
			return false;
		default:
			return assertNever(lifecycle);
	}
}

export function settlementOrder(lifecycle: RunLifecycle): number {
	switch (lifecycle.kind) {
		case "creating":
		case "running":
		case "stopping":
			return 0;
		case "settled":
			return lifecycle.settlementOrder;
		default:
			return assertNever(lifecycle);
	}
}

export function ownedChild(lifecycle: RunLifecycle): OwnedChild | undefined {
	switch (lifecycle.kind) {
		case "creating":
		case "settled":
			return undefined;
		case "running":
			return {
				kind: "owned",
				child: lifecycle.child,
				unsubscribe: lifecycle.unsubscribe,
			};
		case "stopping":
			return lifecycle.child.kind === "owned" ? lifecycle.child : undefined;
		default:
			return assertNever(lifecycle);
	}
}
