const { statSync } = process.getBuiltinModule("fs");
const { resolve } = process.getBuiltinModule("path");

import { Cause, Clock, Effect, Fiber } from "effect";
import type { DelegateSnapshot } from "./contract.ts";
import {
	DelegateRun,
	type DelegateRunOptions,
	type DelegateRunRequest,
} from "./delegate-run.ts";
import { errorMessage } from "./errors.ts";
import {
	type ChildSession,
	readProjectDelegateModelSetting,
	resolveDelegateModel,
	resolveRequestedModel,
	thinkingForEffort,
} from "./runtime.ts";
import { aggregateDelegateUsage } from "./usage.ts";

const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface DelegateRequest extends DelegateRunRequest {}

export interface DelegateManagerOptions {
	createSession?: DelegateRunOptions["createSession"];
	shutdownSession?: (child: ChildSession) => Promise<void>;
	onAccepted?: (snapshot: DelegateSnapshot) => void;
	onStarted?: (snapshot: DelegateSnapshot) => void;
	onSettlement?: (snapshot: DelegateSnapshot) => void;
	onSettled?: (snapshot: DelegateSnapshot) => void;
	recovered?: readonly DelegateSnapshot[];
}

function isDirectory(path: string) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function waitUntil(
	effects: readonly Effect.Effect<unknown, unknown>[],
	deadline: number,
) {
	return Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		yield* Effect.forEach(effects, Effect.exit, {
			concurrency: "unbounded",
		}).pipe(Effect.timeoutOption(Math.max(0, deadline - now)), Effect.asVoid);
	});
}

export class DelegateManager {
	// The product contract deliberately admits every run immediately and retains it for the parent session; the user accepts unbounded aggregate use instead of backpressure or eviction.
	private readonly jobs = new Map<string, DelegateRun>();
	private readonly recovered = new Map<string, DelegateSnapshot>();
	private readonly options: DelegateManagerOptions;
	private readonly runTasks = new Set<Fiber.Fiber<void, never>>();
	private readonly disposals = new Set<Fiber.Fiber<void, never>>();
	private nextId = 0;
	private nextSettlementOrder = 0;
	private disposed: boolean = false;
	private shutdownEffect?: Effect.Effect<void>;

	constructor(options: DelegateManagerOptions = {}) {
		this.options = { ...options };
		for (const snapshot of this.options.recovered ?? [])
			this.recovered.set(snapshot.id, snapshot);
		this.nextId = Math.max(
			0,
			...[...this.recovered].map(
				([id]) => Number(id.replace(/^delegate-/, "")) || 0,
			),
		);
	}

	sessionUsage() {
		return aggregateDelegateUsage(
			this.list().map((snapshot) => ({
				usage: snapshot.childUsage,
				unavailable: snapshot.childUsageUnavailable ?? [],
			})),
		);
	}

	spawn(request: DelegateRequest): DelegateSnapshot {
		if (this.disposed) throw new Error("Delegate manager is shutting down.");
		if (!request.task.trim())
			throw new Error("Delegated task must not be empty.");
		const cwd = resolve(request.ctx.cwd, request.cwd ?? ".");
		if (request.cwd !== undefined && !isDirectory(cwd)) {
			throw new Error(`Delegate cwd is not a directory: ${cwd}`);
		}

		const effort = request.effort === "thorough" ? "thorough" : "fast";
		const setting = readProjectDelegateModelSetting(cwd, {
			parentCwd: request.ctx.cwd,
			effort,
		});
		const modelChoice =
			request.model !== undefined
				? resolveRequestedModel(request.ctx, request.model)
				: resolveDelegateModel(request.ctx, setting);
		const run = new DelegateRun({
			id: `delegate-${++this.nextId}`,
			request: { ...request, cwd },
			effort,
			thinking: setting.thinking ?? thinkingForEffort(effort),
			requestedModel: modelChoice.requestedModel,
			fallbackReason: modelChoice.fallbackReason,
			modelChoice: modelChoice.model,
			createSession: this.options.createSession,
			shutdownSession: this.options.shutdownSession,
			nextSettlementOrder: () => this.nextSettlementOrder + 1,
			onStarted: this.options.onStarted,
			onSettlement: (order, snapshot) => {
				this.nextSettlementOrder = order;
				this.options.onSettlement?.(snapshot);
			},
			onSettled: this.options.onSettled,
			onDisposalStarted: (fiber) => {
				this.disposals.add(fiber);
				fiber.addObserver(() => this.disposals.delete(fiber));
			},
		});
		this.jobs.set(run.id, run);
		const snapshot = run.snapshot();
		this.options.onAccepted?.(snapshot);
		const task = Effect.runFork(
			run.execute().pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						run.settleExecutionError(errorMessage(Cause.squash(cause)));
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
			return [...new Set(ids)].map(
				(id) => this.recovered.get(id) ?? this.requireJob(id).snapshot(),
			);
		}
		return [...this.jobs.values()]
			.map((run) => run.snapshot())
			.concat([...this.recovered.values()])
			.sort(
				(a, b) =>
					Number(a.status !== "running") - Number(b.status !== "running") ||
					(b.settledAt ?? 0) - (a.settledAt ?? 0),
			);
	}

	trail(id: string): readonly string[] {
		const recovered = this.recovered.get(id);
		if (recovered)
			return recovered.checkpoint
				? [recovered.checkpoint]
				: recovered.output
					? [`Assistant\n\n${recovered.output}`]
					: [];
		return this.requireJob(id).trail();
	}

	readonly wait = Effect.fn("DelegateManager.wait")(function* (
		this: DelegateManager,
		ids: readonly string[],
	) {
		const runs = [...new Set(ids)].map((id) => this.requireJob(id));
		if (runs.length === 0) throw new Error("Provide at least one delegate id.");
		return yield* Effect.forEach(runs, (run) => run.awaitCompletion(), {
			concurrency: "unbounded",
		});
	});

	readonly send = Effect.fn("DelegateManager.send")(function* (
		this: DelegateManager,
		id: string,
		message: string,
	) {
		return yield* this.requireJob(id).send(message);
	});

	readonly cancel = Effect.fn("DelegateManager.cancel")(function* (
		this: DelegateManager,
		ids: readonly string[],
	) {
		const runs = [...new Set(ids)].map((id) => this.requireJob(id));
		for (const run of runs) run.consumeDelivery();
		yield* Effect.forEach(runs, (run) => run.stopForCancellation(), {
			concurrency: "unbounded",
		});
		return runs.map((run) => run.snapshot());
	});

	acknowledge(ids: readonly string[]) {
		for (const id of new Set(ids)) this.jobs.get(id)?.consumeDelivery();
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
			const runs = [...this.jobs.values()];
			yield* waitUntil(
				runs.map((run) =>
					run.isActive() ? run.stopForCancellation() : Effect.void,
				),
				deadline,
			);
			yield* waitUntil([...this.runTasks].map(Fiber.await), deadline);
			yield* waitUntil([...this.disposals].map(Fiber.await), deadline);
			for (const run of runs) run.cleanup();
		},
	);

	private requireJob(id: string): DelegateRun {
		if (this.recovered.has(id))
			throw new Error(`Delegate ${id} was recovered for inspection only.`);
		const run = this.jobs.get(id);
		if (!run) throw new Error(`Unknown delegate id "${id}".`);
		return run;
	}
}
