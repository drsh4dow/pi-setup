import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect } from "effect";
import { truncateUtf8Window } from "../../lib/text.ts";
import { COMPACTION_DELIVERY_PAUSE_CHANNEL } from "../compaction/index.ts";
import {
	MAX_ACTIVITIES_PER_SOURCE,
	registerProcessStatusSource,
} from "../process-status/status.ts";
import {
	DelegateRunParams,
	type DelegateSessionDetails,
	DelegateSessionParams,
	type DelegateSnapshot,
	MAX_EXECUTION_MS,
	MAX_EXECUTION_TOKENS,
	RUN_TOOL_NAME,
	SESSION_TOOL_NAME,
} from "./contract.ts";
import { delegateError } from "./errors.ts";
import {
	formatProgress,
	formatStatusParts,
	sessionSummary,
	statusSummary,
	summary,
} from "./format.ts";
import { cancelTimer, scheduleTimer } from "./host-timers.ts";
import { DelegateManager } from "./manager.ts";
import { formatDelegateOutput } from "./output.ts";
import {
	renderDelegateCall,
	renderDelegateResult,
	renderDelegateSessionCall,
	renderDelegateSessionResult,
} from "./render.ts";

export {
	CHILD_EXTENSION_PATHS_ENV,
	type DelegateDetails,
	type DelegateEffort,
	type DelegateOutput,
	type DelegateThinking,
	type DelegateUsageStats,
} from "./contract.ts";
export { extractAssistantText, formatDelegateOutput } from "./output.ts";
export {
	childExtensionPaths,
	DELEGATION_TOOL_DENYLIST,
	readDelegateModelSetting,
	resolveDelegateModel,
	resolveRequestedModel,
	selectChildToolNames,
	thinkingForEffort,
} from "./runtime.ts";

const DELIVERY_RETRY_DELAYS_MS = [25, 100] as const;

function textContent(text: string) {
	return { type: "text" as const, text };
}

function delegateDetail(manager: DelegateManager, id: string) {
	const snapshot = manager.list([id])[0];
	const lines = [
		"Task",
		truncateUtf8Window(
			snapshot.assignedTask,
			4 * 1024,
			2 * 1024,
			"\n\n[task truncated]\n\n",
		),
	];
	if (snapshot.error) lines.push("", "Error", snapshot.error);
	const trail = manager.trail(id);
	lines.push(
		"",
		"Activity",
		"",
		trail.length > 0 ? trail.join("\n\n") : "No recorded activity",
	);
	return lines.join("\n");
}

export const resultText = Effect.fn("resultText")(function* (
	snapshots: DelegateSnapshot[],
) {
	const sections: string[] = [];
	for (const snapshot of snapshots) {
		let text = summary(snapshot);
		if (snapshot.error) text += `\nError: ${snapshot.error}`;
		if (snapshot.checkpoint) {
			text += `\n\nCheckpoint (child's last activity):\n${snapshot.checkpoint}`;
		}
		if (snapshot.fullOutputFile) {
			text += `\nFull output (until parent session ends): ${snapshot.fullOutputFile}`;
		}
		const output = snapshot.output;
		if (output && !snapshot.checkpoint?.includes(output)) {
			text += `\n\n${output}`;
		}
		sections.push(text);
	}
	return (yield* formatDelegateOutput(sections.join("\n\n---\n\n"))).text;
});

export class BackgroundDelivery {
	// The product contract accepts unbounded aggregate delivery state so every admitted background run remains recoverable until the parent session clears it.
	private context: ExtensionContext | undefined;
	private readonly pending = new Map<
		string,
		{
			snapshot: DelegateSnapshot;
			attempts: number;
			exhausted: boolean;
			diagnosed: boolean;
		}
	>();
	private readonly reservations = new Map<symbol, string | undefined>();
	private readonly pi: Pick<ExtensionAPI, "sendMessage">;
	private readonly render: typeof resultText;
	private readonly acknowledge: (ids: readonly string[]) => void;
	private retryTimer: ReturnType<typeof scheduleTimer> | undefined;
	private flushing: boolean = false;
	private paused = false;
	private version = 0;

	constructor(
		pi: Pick<ExtensionAPI, "sendMessage">,
		render: typeof resultText = resultText,
		acknowledge: (ids: readonly string[]) => void = () => {},
	) {
		this.pi = pi;
		this.render = render;
		this.acknowledge = acknowledge;
	}

	setContext(context: ExtensionContext) {
		this.context = context;
		this.paused = false;
		if (this.retryTimer) cancelTimer(this.retryTimer);
		this.retryTimer = undefined;
		this.version++;
		if (context.isIdle()) Effect.runFork(this.flush());
	}

	setPaused(paused: boolean) {
		if (this.paused === paused) return;
		this.paused = paused;
		this.version++;
		if (!paused && this.context?.isIdle()) Effect.runFork(this.flush());
	}

	clear() {
		this.context = undefined;
		if (this.retryTimer) cancelTimer(this.retryTimer);
		this.retryTimer = undefined;
		this.pending.clear();
		this.reservations.clear();
		this.paused = false;
		this.version++;
	}

	reserve(): symbol {
		const reservation = Symbol("delegate-delivery");
		this.reservations.set(reservation, undefined);
		this.version++;
		return reservation;
	}

	attach(reservation: symbol, snapshot: DelegateSnapshot) {
		if (!this.reservations.has(reservation)) {
			throw new Error("Background delivery reservation is no longer active.");
		}
		this.reservations.set(reservation, snapshot.id);
		this.version++;
	}

	release(reservation: symbol) {
		if (this.reservations.delete(reservation)) this.version++;
	}

	consume(snapshots: readonly DelegateSnapshot[]) {
		let changed = false;
		for (const snapshot of snapshots) {
			changed = this.pending.delete(snapshot.id) || changed;
			for (const [reservation, id] of this.reservations) {
				if (id !== snapshot.id) continue;
				this.reservations.delete(reservation);
				changed = true;
			}
		}
		if (changed) this.version++;
		this.acknowledge(snapshots.map((snapshot) => snapshot.id));
	}

	enqueue(snapshot: DelegateSnapshot) {
		if (!this.context) return;
		const existing = this.pending.get(snapshot.id);
		if (existing) existing.snapshot = snapshot;
		else {
			this.pending.set(snapshot.id, {
				snapshot,
				attempts: 0,
				exhausted: false,
				diagnosed: false,
			});
		}
		this.version++;
		if (this.context.isIdle()) Effect.runFork(this.flush());
	}

	flush() {
		const context = this.context;
		if (
			this.flushing ||
			this.paused ||
			this.retryTimer ||
			!context ||
			this.pending.size === 0
		)
			return Effect.void;
		const entries = [...this.pending.values()].filter(
			(entry) => !entry.exhausted,
		);
		if (entries.length === 0) return Effect.void;
		this.flushing = true;
		const startVersion = this.version;
		const snapshots = entries.map((entry) => entry.snapshot);
		return Effect.gen(
			function* (this: BackgroundDelivery) {
				const outcome = yield* this.render(snapshots).pipe(
					Effect.flatMap((content) =>
						Effect.try({
							try: () => {
								if (
									this.context !== context ||
									this.paused ||
									entries.some(
										(entry) => this.pending.get(entry.snapshot.id) !== entry,
									)
								) {
									return;
								}
								this.pi.sendMessage(
									{
										customType: "delegate-results",
										content: `[Background delegation results]\n\n${content}`,
										display: true,
										details: {
											ids: snapshots.map((snapshot) => snapshot.id),
										},
									},
									{ deliverAs: "followUp", triggerTurn: true },
								);
								this.consume(snapshots);
							},
							catch: delegateError,
						}),
					),
					Effect.exit,
				);
				if (outcome._tag === "Success" || this.context !== context) return;
				const exhausted: string[] = [];
				let retryDelay: number | undefined;
				for (const entry of entries) {
					if (this.pending.get(entry.snapshot.id) !== entry) continue;
					entry.attempts++;
					if (entry.attempts > DELIVERY_RETRY_DELAYS_MS.length) {
						entry.exhausted = true;
						if (!entry.diagnosed) {
							entry.diagnosed = true;
							exhausted.push(entry.snapshot.id);
						}
					} else {
						retryDelay = Math.min(
							retryDelay ?? Number.POSITIVE_INFINITY,
							DELIVERY_RETRY_DELAYS_MS[entry.attempts - 1],
						);
					}
				}
				if (exhausted.length > 0) {
					const evidence = String(Cause.squash(outcome.cause))
						.replace(/\s+/g, " ")
						.slice(0, 512);
					for (const id of exhausted) {
						yield* Effect.logError(
							`[delegate] background delivery failed for ${id}; use delegate_session wait to recover retained results: ${evidence}`,
						);
					}
				}
				if (retryDelay !== undefined) {
					this.retryTimer = scheduleTimer(() => {
						this.retryTimer = undefined;
						if (this.context?.isIdle()) Effect.runFork(this.flush());
					}, retryDelay);
					this.retryTimer.unref?.();
				}
			}.bind(this),
		).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					this.flushing = false;
					if (
						!this.retryTimer &&
						this.version !== startVersion &&
						!this.paused &&
						this.context?.isIdle() &&
						[...this.pending.values()].some((entry) => !entry.exhausted)
					) {
						Effect.runFork(this.flush());
					}
				}),
			),
		);
	}
}

export default function delegateExtension(pi: ExtensionAPI) {
	let manager!: DelegateManager;
	const delivery = new BackgroundDelivery(pi, resultText, (ids) =>
		manager.acknowledge(ids),
	);
	manager = new DelegateManager({
		onSettled: (snapshot) => delivery.enqueue(snapshot),
	});
	registerProcessStatusSource(
		pi,
		"delegate",
		() =>
			manager
				.list()
				.slice(0, MAX_ACTIVITIES_PER_SOURCE)
				.map((snapshot) => ({
					id: snapshot.id,
					kind: "subagents" as const,
					active: snapshot.status === "running",
					summary: [statusSummary(snapshot), formatProgress(snapshot)]
						.filter(Boolean)
						.join(" · "),
					usage: {
						tokens: snapshot.childUsage.totalTokens,
						cost: snapshot.childUsage.cost,
					},
					detail: () => delegateDetail(manager, snapshot.id),
				})),
		() => manager.sessionUsage(),
	);

	pi.events.on(COMPACTION_DELIVERY_PAUSE_CHANNEL, (paused) => {
		if (typeof paused === "boolean") delivery.setPaused(paused);
	});
	pi.on("session_start", (_event, ctx) => delivery.setContext(ctx));
	pi.on("agent_settled", () => Effect.runPromise(delivery.flush()));
	pi.on("session_shutdown", () => {
		delivery.clear();
		return Effect.runPromise(manager.shutdown());
	});

	pi.registerTool<typeof DelegateRunParams, DelegateSnapshot>({
		name: RUN_TOOL_NAME,
		label: "Delegate Run",
		description: `Creates one child with fresh context for one self-contained task. State the objective, relevant context and files, mutation permission, constraints, verification, and expected result. Multiple delegate_run calls issued together execute concurrently and settle independently; chain dependent work by using each completed result to compose the next task. By default the call blocks until completion; background=true returns the child id immediately and delivers the result later. Every run is terminated at ${MAX_EXECUTION_MS / 60_000} minutes of wall time or ${MAX_EXECUTION_TOKENS.toLocaleString("en-US")} tokens whatever its effort, so size a task by the minutes it needs. Children share one worktree without write isolation unless you point them elsewhere with cwd. output_format is advisory: correct and complete information takes precedence over exact formatting.`,
		promptSnippet:
			"Create exactly one fresh child, blocking by default or delivering later in background",
		promptGuidelines: [
			"Use one delegate_run call per child. Issue independent calls together for parallel work; for dependent work, wait and compose a new self-contained task from the earlier result.",
			"Child context is fresh and cannot see the parent conversation; include every fact and permission it needs in the task.",
			"Never start background then immediately wait; use a blocking run. For background runs, continue useful parent work and wait only when blocked.",
			"Concurrent children share the same worktree without isolation or write-conflict protection.",
			"Parent owns final integration and verification unless the task explicitly delegates them.",
		],
		parameters: DelegateRunParams,
		executionMode: "parallel",
		execute(_toolCallId, params, signal, onUpdate, ctx) {
			let spawnedId: string | undefined;
			return Effect.runPromise(
				Effect.gen(function* () {
					const reservation = params.background
						? delivery.reserve()
						: undefined;
					const snapshot = yield* Effect.try({
						try: () => {
							const spawned = manager.spawn({
								task: params.task,
								model: params.model,
								effort: params.effort,
								outputFormat: params.output_format,
								background: params.background,
								cwd: params.cwd,
								ctx,
							});
							spawnedId = spawned.id;
							if (reservation) delivery.attach(reservation, spawned);
							return spawned;
						},
						catch: (error) => {
							if (reservation) delivery.release(reservation);
							return delegateError(error);
						},
					});
					if (params.background) {
						return {
							content: [
								textContent(
									`${summary(snapshot)}\nResult will be delivered automatically; continue useful work and wait only when blocked.`,
								),
							],
							details: snapshot,
						};
					}
					const unsubscribe = manager.subscribe((update) => {
						if (update.id !== snapshot.id) return;
						onUpdate?.({
							content: [textContent(`Delegating (${update.effort})...`)],
							details: update,
						});
					});
					try {
						const [result] = yield* manager.wait([snapshot.id], signal);
						if (!result.success) {
							const reason = result.error ?? result.status;
							const checkpoint = result.checkpoint
								? `\n\nCheckpoint (child's last activity):\n${result.checkpoint}`
								: "";
							throw new Error(
								`Delegated task ${result.id} failed: ${reason} (${formatStatusParts(result)}). Use delegate_session wait with ids=["${result.id}"] to recover retained output.${checkpoint}`,
							);
						}
						const output = yield* formatDelegateOutput(
							result.output ||
								"Delegated task completed without a final response.",
							result.fullOutputFile,
						);
						return {
							content: [textContent(output.text)],
							details: {
								...result,
								outputTruncated:
									result.outputTruncated || output.truncation?.truncated,
								fullOutputFile: result.fullOutputFile ?? output.fullOutputFile,
							},
						};
					} finally {
						unsubscribe();
					}
				}).pipe(
					Effect.ensuring(
						Effect.suspend(() =>
							signal?.aborted && spawnedId
								? manager.cancel([spawnedId]).pipe(Effect.asVoid)
								: Effect.void,
						),
					),
				),
			);
		},
		renderCall: renderDelegateCall,
		renderResult: renderDelegateResult,
	});

	pi.registerTool<typeof DelegateSessionParams, DelegateSessionDetails>({
		name: SESSION_TOOL_NAME,
		label: "Delegate Session",
		description:
			"Manages children created by delegate_run. list recovers all ids retained for the current parent session; status inspects without waiting; wait returns outputs; send steers one running child; cancel stops work. Settled children cannot receive more messages or resume; create a new child for further work. Never start a background run and then immediately wait; use a blocking delegate_run instead.",
		promptSnippet:
			"List, inspect, wait for, steer, or cancel existing child sessions",
		promptGuidelines: [
			"Use send only to steer a running child. A child sees its own session, not the parent conversation, so include any new context it needs.",
			"After a background run, continue useful parent work and wait only when blocked.",
			"A settled child is finished and cannot be resumed; use delegate_run for new work. Tracked ids last only for the current parent session.",
		],
		parameters: DelegateSessionParams,
		executionMode: "parallel",
		execute(_toolCallId, params, signal) {
			return Effect.runPromise(
				Effect.gen(function* () {
					if (params.action === "send") {
						if (!params.id || !params.message) {
							throw new Error("send requires id and message.");
						}
						const snapshot = yield* manager.send(params.id, params.message);
						return {
							content: [textContent(`Message sent. ${summary(snapshot)}`)],
							details: snapshot,
						};
					}
					const ids = params.ids ?? [];
					if (params.action === "list") {
						const snapshots = manager.list();
						const output = yield* formatDelegateOutput(
							snapshots.length > 0
								? snapshots.map(sessionSummary).join("\n")
								: "No delegates are tracked.",
						);
						return {
							content: [textContent(output.text)],
							details: { results: snapshots },
						};
					}
					if (ids.length === 0) {
						throw new Error("Provide at least one delegate id.");
					}
					if (params.action === "wait" || params.action === "cancel") {
						const snapshots =
							params.action === "wait"
								? yield* manager.wait(ids, signal)
								: yield* manager.cancel(ids);
						delivery.consume(snapshots);
						return {
							content: [textContent(yield* resultText(snapshots))],
							details: { results: snapshots },
						};
					}
					const snapshots = manager.list(ids);
					return {
						content: [textContent(snapshots.map(sessionSummary).join("\n"))],
						details: { results: snapshots },
					};
				}),
			);
		},
		renderCall: renderDelegateSessionCall,
		renderResult: renderDelegateSessionResult,
	});
}
