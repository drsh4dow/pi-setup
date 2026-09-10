import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect } from "effect";
import { truncateUtf8Window } from "../../lib/text.ts";
import {
	MAX_ACTIVITIES_PER_SOURCE,
	registerProcessStatusSource,
	requestProcessStatusRefresh,
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
	sessionSummary,
	statusSummary,
	summary,
} from "./format.ts";
import { cancelTimer, scheduleTimer } from "./host-timers.ts";
import { DelegateManager } from "./manager.ts";
import { formatDelegateOutput } from "./output.ts";
import {
	DELEGATE_STATE_ENTRY,
	delegateStateRecord,
	recoverDelegateStates,
} from "./persistence.ts";
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
	type DelegateThinking,
	type DelegateUsageStats,
} from "./contract.ts";
export { formatDelegateOutput } from "./output.ts";
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
		if (snapshot.childSessionFile) {
			text += `\nNative child session: ${snapshot.childSessionId ?? "unknown"}\nConversation file: ${snapshot.childSessionFile}`;
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
	// Every admitted run remains inspectable until the parent session clears it.
	private context: ExtensionContext | undefined;
	private readonly pending = new Map<
		string,
		{
			readonly snapshot: DelegateSnapshot;
			attempts: number;
		}
	>();
	private readonly pi: Pick<ExtensionAPI, "sendMessage">;
	private readonly render: typeof resultText;
	private readonly acknowledge: (ids: readonly string[]) => void;
	private retryTimer: ReturnType<typeof scheduleTimer> | undefined;
	private flushing: boolean = false;
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
		if (this.retryTimer) cancelTimer(this.retryTimer);
		this.retryTimer = undefined;
		this.version++;
		this.scheduleFlush();
	}

	clear() {
		this.context = undefined;
		if (this.retryTimer) cancelTimer(this.retryTimer);
		this.retryTimer = undefined;
		this.pending.clear();
		this.version++;
	}

	consume(snapshots: readonly DelegateSnapshot[]) {
		let changed = false;
		for (const snapshot of snapshots) {
			changed = this.pending.delete(snapshot.id) || changed;
		}
		if (changed) this.version++;
		this.acknowledge(snapshots.map((snapshot) => snapshot.id));
	}

	enqueue(snapshot: DelegateSnapshot) {
		if (!this.context) return;
		this.pending.set(snapshot.id, { snapshot, attempts: 0 });
		this.version++;
		this.scheduleFlush();
	}

	private scheduleFlush() {
		queueMicrotask(() => Effect.runFork(this.flush()));
	}

	flush() {
		const context = this.context;
		if (this.flushing || this.retryTimer || !context || this.pending.size === 0)
			return Effect.void;
		const entries = [...this.pending.values()].filter(
			(entry) => entry.attempts <= DELIVERY_RETRY_DELAYS_MS.length,
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
									{ deliverAs: "steer", triggerTurn: true },
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
						exhausted.push(entry.snapshot.id);
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
							`[delegate] background delivery failed for ${id}; inspect the retained status or native child session: ${evidence}`,
						);
					}
				}
				if (retryDelay !== undefined) {
					this.retryTimer = scheduleTimer(() => {
						this.retryTimer = undefined;
						Effect.runFork(this.flush());
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
						this.context &&
						[...this.pending.values()].some(
							(entry) => entry.attempts <= DELIVERY_RETRY_DELAYS_MS.length,
						)
					) {
						this.scheduleFlush();
					}
				}),
			),
		);
	}
}

export default function delegateExtension(pi: ExtensionAPI) {
	let manager = new DelegateManager();
	const delivery = new BackgroundDelivery(pi, resultText, (ids) =>
		manager.acknowledge(ids),
	);
	const openManager = (ctx: ExtensionContext) => {
		const persist = (
			kind: "accepted" | "started" | "settled",
			snapshot: DelegateSnapshot,
		) => {
			if (!ctx.sessionManager.getSessionFile()) return;
			pi.appendEntry(
				DELEGATE_STATE_ENTRY,
				delegateStateRecord(ctx.sessionManager.getSessionId(), kind, snapshot),
			);
		};
		return new DelegateManager({
			recovered: recoverDelegateStates(ctx.sessionManager),
			onAccepted: (snapshot) => persist("accepted", snapshot),
			onStarted: (snapshot) => {
				persist("started", snapshot);
				requestProcessStatusRefresh(pi);
			},
			onSettlement: (snapshot) => {
				persist("settled", snapshot);
				requestProcessStatusRefresh(pi);
			},
			onSettled: (snapshot) => delivery.enqueue(snapshot),
		});
	};
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
						totalTokens: snapshot.childUsageUnavailable?.includes("totalTokens")
							? null
							: snapshot.childUsage.totalTokens,
						cost: snapshot.childUsageUnavailable?.includes("cost")
							? null
							: snapshot.childUsage.cost,
					},
					detail: () => delegateDetail(manager, snapshot.id),
				})),
		() => manager.sessionUsage(),
	);

	pi.on("session_start", (_event, ctx) => {
		manager = openManager(ctx);
		delivery.setContext(ctx);
	});
	pi.on("session_shutdown", () => {
		delivery.clear();
		return Effect.runPromise(manager.shutdown());
	});

	pi.registerTool<typeof DelegateRunParams, DelegateSnapshot>({
		name: RUN_TOOL_NAME,
		label: "Delegate Run",
		description: `Creates one child with fresh context for one bounded assignment, returns its id immediately, and delivers its result automatically. State the objective, relevant context and files, mutation permission, constraints, verification, and expected result. Multiple delegate_run calls issued together execute concurrently and settle independently; chain dependent work by using each completed result to compose the next task. Every run is terminated at ${MAX_EXECUTION_MS / 60_000} minutes of wall time or ${MAX_EXECUTION_TOKENS.toLocaleString("en-US")} tokens whatever its effort, so size a task by the minutes it needs. Children share one worktree without write isolation unless you point them elsewhere with cwd. output_format is advisory: correct and complete information takes precedence over exact formatting.`,
		promptSnippet:
			"Create exactly one fresh child and return its id immediately",
		promptGuidelines: [
			"Give each child a bounded assignment with sufficient context. Keep concurrent write targets separate.",
			"Results arrive automatically. Use status only to inspect current state.",
		],
		parameters: DelegateRunParams,
		executionMode: "parallel",
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return Effect.runPromise(
				Effect.try({
					try: () =>
						manager.spawn({
							task: params.task,
							model: params.model,
							effort: params.effort,
							outputFormat: params.output_format,
							cwd: params.cwd,
							ctx,
						}),
					catch: delegateError,
				}).pipe(
					Effect.map((snapshot) => ({
						content: [
							textContent(
								`${summary(snapshot)}\nResult will be delivered automatically; the parent may continue.`,
							),
						],
						details: snapshot,
					})),
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
			"Manages children created by delegate_run. list recovers all ids retained for the current parent session; status inspects current state; send steers one running child; cancel stops work. Background results arrive automatically. Settled children cannot receive more messages or resume; handle small follow-ups directly.",
		promptSnippet: "List, inspect, steer, or cancel existing child sessions",
		promptGuidelines: [
			"Use delegate_session send only for new facts, corrections, or changed scope. It is not required after spawning and does not wake, poll, or restart a child. Success confirms queuing, not that the child has read or followed the message. Tracked ids last only for the current parent session.",
		],
		parameters: DelegateSessionParams,
		executionMode: "parallel",
		execute(_toolCallId, params) {
			return Effect.runPromise(
				Effect.gen(function* () {
					if (params.action === "send") {
						yield* manager.send(params.id, params.message);
						return {
							content: [textContent(`Steering queued for ${params.id}.`)],
							details: undefined,
						};
					}
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
					const ids = params.ids;
					if (params.action === "cancel") {
						const snapshots = yield* manager.cancel(ids);
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
