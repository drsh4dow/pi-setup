import { Clock, Config, Deferred, Effect } from "effect";
import { sacrificeKillNote, tagCommand } from "../../lib/sacrifice.ts";
import {
	NOTIFICATION_FD,
	NotificationFrames,
	notificationEnvironment,
	type RunningTerminalNotification,
} from "./notifications.ts";

const { spawn } = process.getBuiltinModule("node:child_process");
type ChildProcess = ReturnType<typeof spawn>;

// Capacity is per owner, not shared: a session's terminals are its own, so no wave of
// delegated children can exhaust the parent's slots. earlyoom bounds the machine.
export const MAX_RUNNING_PER_OWNER = 8;
export const MAX_TRACKED = 32;
export const RETAINED_BYTES = 256 * 1024;
const TERM_GRACE_MS = 2_000;
const PIPE_GRACE_MS = 1_000;
const CLOSE_GRACE_MS = 750;
const TASKKILL_GRACE_MS = 1_000;
const GROUP_CHECK_MS = 100;
const schedule = (delayMs: number, action: () => void) =>
	Effect.runFork(Effect.delay(Effect.sync(action), delayMs));

interface OutputTail {
	text: string;
	totalBytes: number;
	truncatedBytes: number;
}
interface TerminalSnapshotBase {
	id: string;
	command: string;
	title: string;
	cwd: string;
	pid?: number;
	createdAt: number;
	stdout: OutputTail;
	stderr: OutputTail;
}

declare const NonZeroExitCodeType: unique symbol;
type NonZeroExitCode = number & {
	readonly [NonZeroExitCodeType]: "NonZeroExitCode";
};
type ProcessExit =
	| { kind: "success" }
	| { kind: "nonzero-exit"; code: NonZeroExitCode }
	| { kind: "signal"; signal: string }
	| { kind: "unknown" };
type NonSuccessProcessExit = Exclude<ProcessExit, { kind: "success" }>;

function makeNonZeroExitCode(code: number): NonZeroExitCode {
	if (!Number.isInteger(code) || code === 0)
		throw new Error(`Expected a nonzero integer exit code, received ${code}.`);
	return code as NonZeroExitCode;
}

export type RunningTerminalSnapshot = TerminalSnapshotBase & {
	state: "running";
	settledAt?: never;
	process:
		| { kind: "executing"; error?: string }
		| { kind: "observed-exit"; exit: ProcessExit; error?: string };
};
export type SettledTerminalSnapshot =
	| (TerminalSnapshotBase & {
			state: "done";
			settledAt: number;
			result: { kind: "success" };
	  })
	| (TerminalSnapshotBase & {
			state: "failed";
			settledAt: number;
			result:
				| { kind: "process-failure"; exit: NonSuccessProcessExit }
				| { kind: "error"; error: string; exit: ProcessExit };
	  })
	| (TerminalSnapshotBase & {
			state: "killed";
			settledAt: number;
			result: { kind: "killed"; exit: ProcessExit; error?: string };
	  });
export type TerminalSnapshot =
	| RunningTerminalSnapshot
	| SettledTerminalSnapshot;

export interface TerminalResultFields {
	exitCode: number | undefined;
	signal: string | undefined;
	error: string | undefined;
}

class Tail {
	private chunks: Buffer[] = [];
	private headOffset = 0;
	private retainedBytes = 0;
	totalBytes = 0;
	append(chunk: Buffer) {
		this.totalBytes += chunk.length;
		if (chunk.length >= RETAINED_BYTES) {
			let start = chunk.length - RETAINED_BYTES;
			while (start < chunk.length && (chunk[start] & 0xc0) === 0x80) start++;
			const retained = Buffer.from(chunk.subarray(start));
			this.chunks = retained.length ? [retained] : [];
			this.headOffset = 0;
			this.retainedBytes = retained.length;
			return;
		}
		this.chunks.push(chunk);
		this.retainedBytes += chunk.length;
		let discard = Math.max(0, this.retainedBytes - RETAINED_BYTES);
		while (discard > 0) {
			const available = this.chunks[0].length - this.headOffset;
			if (discard < available) {
				this.headOffset += discard;
				this.retainedBytes -= discard;
				discard = 0;
			} else {
				discard -= available;
				this.retainedBytes -= available;
				this.chunks.shift();
				this.headOffset = 0;
			}
		}
		while (
			this.retainedBytes > 0 &&
			(this.chunks[0][this.headOffset] & 0xc0) === 0x80
		) {
			this.headOffset++;
			this.retainedBytes--;
			if (this.headOffset === this.chunks[0].length) {
				this.chunks.shift();
				this.headOffset = 0;
			}
		}
		if (this.chunks.length > 128) {
			this.chunks = [this.buffer()];
			this.headOffset = 0;
		}
	}
	private buffer(): Buffer {
		if (this.chunks.length === 0) return Buffer.alloc(0);
		if (this.chunks.length === 1)
			return this.chunks[0].subarray(this.headOffset);
		return Buffer.concat([
			this.chunks[0].subarray(this.headOffset),
			...this.chunks.slice(1),
		]);
	}
	view(): OutputTail {
		return {
			text: this.buffer().toString("utf8"),
			totalBytes: this.totalBytes,
			truncatedBytes: this.totalBytes - this.retainedBytes,
		};
	}
}

type ProcessObservation =
	| { kind: "executing" }
	| { kind: "draining-after-exit"; exit: ProcessExit }
	| { kind: "reaping-after-pipe-close"; exit: ProcessExit };
type TerminationIntent = "automatic" | "kill" | "shutdown";

interface ActiveTerminal {
	id: string;
	command: string;
	title: string;
	cwd: string;
	pid?: number;
	createdAt: number;
	child: ChildProcess;
	stdout: Tail;
	stderr: Tail;
	notifications: NotificationFrames;
	observation: ProcessObservation;
	processError?: string;
	settlement: Deferred.Deferred<SettledTerminalSnapshot>;
	waiters: { count: number };
}
type ActiveEntry =
	| { kind: "running"; terminal: ActiveTerminal }
	| {
			kind: "terminating";
			terminal: ActiveTerminal;
			intent: TerminationIntent;
	  };
type Entry =
	| ActiveEntry
	| { kind: "settled"; snapshot: SettledTerminalSnapshot };
type ManagerLifecycle =
	| { kind: "running" }
	| { kind: "stopping"; completion: Deferred.Deferred<void> }
	| { kind: "stopped" };

function assertNever(value: never): never {
	throw new Error(`Unexpected terminal lifecycle variant: ${String(value)}`);
}
function processExit(
	code: number | null,
	signal: NodeJS.Signals | null,
): ProcessExit {
	if (signal !== null) return { kind: "signal", signal };
	if (code === 0) return { kind: "success" };
	if (code !== null)
		return { kind: "nonzero-exit", code: makeNonZeroExitCode(code) };
	return { kind: "unknown" };
}
function processExitFields(
	exit: ProcessExit,
): Omit<TerminalResultFields, "error"> {
	switch (exit.kind) {
		case "success":
			return { exitCode: 0, signal: undefined };
		case "nonzero-exit":
			return { exitCode: exit.code, signal: undefined };
		case "signal":
			return { exitCode: undefined, signal: exit.signal };
		case "unknown":
			return { exitCode: undefined, signal: undefined };
		default:
			return assertNever(exit);
	}
}
function observationExit(observation: ProcessObservation): ProcessExit {
	switch (observation.kind) {
		case "executing":
			return { kind: "unknown" };
		case "draining-after-exit":
		case "reaping-after-pipe-close":
			return observation.exit;
		default:
			return assertNever(observation);
	}
}
function snapshotExit(snapshot: TerminalSnapshot): ProcessExit | undefined {
	if (snapshot.state === "running")
		return snapshot.process.kind === "executing"
			? undefined
			: snapshot.process.exit;
	switch (snapshot.state) {
		case "done":
			return { kind: "success" };
		case "failed":
			return snapshot.result.exit;
		case "killed":
			return snapshot.result.exit;
		default:
			return assertNever(snapshot);
	}
}
function snapshotError(snapshot: TerminalSnapshot): string | undefined {
	switch (snapshot.state) {
		case "running":
			return snapshot.process.error;
		case "done":
			return undefined;
		case "failed":
			switch (snapshot.result.kind) {
				case "process-failure":
					return undefined;
				case "error":
					return snapshot.result.error;
				default:
					return assertNever(snapshot.result);
			}
		case "killed":
			return snapshot.result.error;
		default:
			return assertNever(snapshot);
	}
}
export function terminalResultFields(
	snapshot: TerminalSnapshot,
): TerminalResultFields {
	const exit = snapshotExit(snapshot);
	return {
		...(exit
			? processExitFields(exit)
			: { exitCode: undefined, signal: undefined }),
		error: snapshotError(snapshot),
	};
}

export class BackgroundTerminalManager {
	private readonly entries = new Map<string, Entry>();
	private counter = 0;
	private notificationSequence = 0;
	private lifecycle: ManagerLifecycle = { kind: "running" };
	private readonly onSettled?: (
		snapshot: SettledTerminalSnapshot,
		consumed: boolean,
	) => void;
	private readonly allocateId: () => string;
	private readonly onNotification?: (
		notification: RunningTerminalNotification,
	) => void;
	constructor(
		onSettled?: (snapshot: SettledTerminalSnapshot, consumed: boolean) => void,
		allocateId?: () => string,
		onNotification?: (notification: RunningTerminalNotification) => void,
	) {
		this.onSettled = onSettled;
		this.allocateId = allocateId ?? (() => `bt-${++this.counter}`);
		this.onNotification = onNotification;
	}

	list(): TerminalSnapshot[] {
		return [...this.entries.values()].map((entry) => this.snapshot(entry));
	}
	get(id: string): TerminalSnapshot | undefined {
		const entry = this.entries.get(id);
		return entry ? this.snapshot(entry) : undefined;
	}
	private snapshot(entry: Entry): TerminalSnapshot {
		switch (entry.kind) {
			case "running":
			case "terminating":
				return this.activeSnapshot(entry);
			case "settled":
				return entry.snapshot;
			default:
				return assertNever(entry);
		}
	}
	private activeSnapshot(entry: ActiveEntry): RunningTerminalSnapshot {
		const terminal = entry.terminal;
		const process: RunningTerminalSnapshot["process"] =
			terminal.observation.kind === "executing"
				? {
						kind: "executing",
						...(terminal.processError ? { error: terminal.processError } : {}),
					}
				: {
						kind: "observed-exit",
						exit: terminal.observation.exit,
						...(terminal.processError ? { error: terminal.processError } : {}),
					};
		return {
			id: terminal.id,
			command: terminal.command,
			title: terminal.title,
			cwd: terminal.cwd,
			pid: terminal.pid,
			state: "running",
			createdAt: terminal.createdAt,
			process,
			stdout: terminal.stdout.view(),
			stderr: terminal.stderr.view(),
		};
	}
	private prune(limit = MAX_TRACKED) {
		while (this.entries.size > limit) {
			const oldest = [...this.entries.values()]
				.filter(
					(entry): entry is Extract<Entry, { kind: "settled" }> =>
						entry.kind === "settled",
				)
				.sort((a, b) => a.snapshot.settledAt - b.snapshot.settledAt)[0];
			if (!oldest) return;
			this.entries.delete(oldest.snapshot.id);
		}
	}

	start(options: {
		command: string;
		title: string;
		cwd: string;
	}): RunningTerminalSnapshot {
		if (this.lifecycle.kind !== "running")
			throw new Error("Background terminal manager is shutting down.");
		this.prune(MAX_TRACKED - 1);
		const invocation =
			process.platform === "win32"
				? {
						file: Effect.runSync(
							Config.string("ComSpec").pipe(Config.withDefault("cmd.exe")),
						),
						args: ["/d", "/s", "/c", options.command],
					}
				: { file: "/bin/sh", args: ["-c", tagCommand(options.command)] };
		const child = spawn(invocation.file, invocation.args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
			env: notificationEnvironment(),
		});
		const id = this.allocateId();
		const terminal: ActiveTerminal = {
			id,
			command: options.command,
			title: options.title,
			cwd: options.cwd,
			pid: child.pid,
			createdAt: Effect.runSync(Clock.currentTimeMillis),
			child,
			stdout: new Tail(),
			stderr: new Tail(),
			notifications: new NotificationFrames(),
			observation: { kind: "executing" },
			settlement: Deferred.makeUnsafe<SettledTerminalSnapshot>(),
			waiters: { count: 0 },
		};
		const entry: Entry = { kind: "running", terminal };
		this.entries.set(id, entry);
		child.stdout?.on("data", (chunk: Buffer) =>
			this.appendOutput(id, "stdout", chunk),
		);
		child.stderr?.on("data", (chunk: Buffer) =>
			this.appendOutput(id, "stderr", chunk),
		);
		child.stdio[NOTIFICATION_FD]?.on("data", (chunk: Buffer) =>
			this.appendNotification(id, chunk),
		);
		child.once("error", (error) => this.observeError(id, error));
		child.once("exit", (code, signal) =>
			this.observeExit(id, processExit(code, signal)),
		);
		child.once("close", (code, signal) =>
			this.observePipeClose(id, processExit(code, signal)),
		);
		return this.activeSnapshot(entry);
	}

	private active(id: string): ActiveEntry | undefined {
		const entry = this.entries.get(id);
		return entry?.kind === "running" || entry?.kind === "terminating"
			? entry
			: undefined;
	}
	private replaceTerminal(entry: ActiveEntry, terminal: ActiveTerminal) {
		this.entries.set(
			terminal.id,
			entry.kind === "running"
				? { kind: "running", terminal }
				: {
						kind: "terminating",
						terminal,
						intent: entry.intent,
					},
		);
	}
	private appendOutput(id: string, stream: "stdout" | "stderr", chunk: Buffer) {
		const entry = this.active(id);
		if (entry) entry.terminal[stream].append(chunk);
	}
	private appendNotification(id: string, chunk: Buffer) {
		const entry = this.active(id);
		if (!entry) return;
		for (const message of entry.terminal.notifications.append(chunk)) {
			try {
				this.onNotification?.({
					id: `${id}:notification-${++this.notificationSequence}`,
					terminalId: id,
					title: entry.terminal.title,
					message,
				});
			} catch {
				// Notification delivery does not own process lifecycle state.
			}
		}
	}
	private observeError(id: string, error: Error) {
		const entry = this.active(id);
		if (!entry) return;
		this.replaceTerminal(entry, {
			...entry.terminal,
			processError: String(error.message).slice(0, 4096),
		});
	}
	private observeExit(id: string, exit: ProcessExit) {
		const entry = this.active(id);
		if (entry?.terminal.observation.kind !== "executing") return;
		this.replaceTerminal(entry, {
			...entry.terminal,
			observation: { kind: "draining-after-exit", exit },
		});
		schedule(PIPE_GRACE_MS, () => this.onPipeTimeout(id));
	}
	private onPipeTimeout(id: string) {
		const entry = this.active(id);
		if (entry?.terminal.observation.kind !== "draining-after-exit") return;
		Effect.runFork(this.terminate(id, "automatic"));
	}
	private observePipeClose(id: string, closeExit: ProcessExit) {
		const entry = this.active(id);
		if (!entry) return;
		const exit =
			entry.terminal.observation.kind === "executing"
				? closeExit
				: entry.terminal.observation.exit;
		this.replaceTerminal(entry, {
			...entry.terminal,
			observation: { kind: "reaping-after-pipe-close", exit },
		});
		this.settleWhenProcessGroupExits(id);
	}

	private processGroupExists(entry: ActiveEntry): boolean {
		if (process.platform === "win32" || !entry.terminal.pid) return false;
		try {
			process.kill(-entry.terminal.pid, 0);
			return true;
		} catch (error) {
			return (
				error instanceof Error && "code" in error && error.code === "EPERM"
			);
		}
	}
	private settleWhenProcessGroupExits(id: string) {
		const entry = this.active(id);
		if (entry?.terminal.observation.kind !== "reaping-after-pipe-close") return;
		if (!this.processGroupExists(entry)) {
			this.settle(id);
			return;
		}
		schedule(GROUP_CHECK_MS, () => this.settleWhenProcessGroupExits(id));
	}

	private settle(id: string): SettledTerminalSnapshot | undefined {
		const entry = this.active(id);
		if (!entry) return;
		const terminal = entry.terminal;
		const exit = observationExit(terminal.observation);
		let error = terminal.processError;
		if (entry.kind === "running" && !error) {
			const note = sacrificeKillNote(
				processExitFields(exit),
				terminal.createdAt,
			);
			if (note) error = note;
		}
		const base = {
			id: terminal.id,
			command: terminal.command,
			title: terminal.title,
			cwd: terminal.cwd,
			pid: terminal.pid,
			createdAt: terminal.createdAt,
			settledAt: Effect.runSync(Clock.currentTimeMillis),
			stdout: terminal.stdout.view(),
			stderr: terminal.stderr.view(),
		};
		const killed = entry.kind === "terminating" && entry.intent !== "automatic";
		const snapshot: SettledTerminalSnapshot = killed
			? {
					...base,
					state: "killed",
					result: {
						kind: "killed",
						exit,
						...(error ? { error } : {}),
					},
				}
			: error
				? {
						...base,
						state: "failed",
						result: { kind: "error", error, exit },
					}
				: exit.kind === "success"
					? { ...base, state: "done", result: { kind: "success" } }
					: {
							...base,
							state: "failed",
							result: { kind: "process-failure", exit },
						};
		this.entries.set(id, { kind: "settled", snapshot });
		try {
			if (this.lifecycle.kind === "running")
				this.onSettled?.(
					snapshot,
					terminal.waiters.count > 0 ||
						(entry.kind === "terminating" && entry.intent === "kill"),
				);
		} catch {
			// Notification failures do not own process lifecycle state.
		}
		Effect.runSync(Deferred.succeed(terminal.settlement, snapshot));
		this.prune();
		return snapshot;
	}

	private setProcessError(id: string, message: string) {
		const entry = this.active(id);
		if (!entry) return;
		this.replaceTerminal(entry, {
			...entry.terminal,
			processError: message,
		});
	}
	private signalTree = Effect.fn("BackgroundTerminalManager.signalTree")(
		function* (this: BackgroundTerminalManager, id: string, force: boolean) {
			const entry = this.active(id);
			if (!entry) return;
			const signal = force ? "SIGKILL" : "SIGTERM";
			if (process.platform === "win32" && entry.terminal.pid) {
				const killer = spawn(
					"taskkill",
					["/pid", String(entry.terminal.pid), "/T", ...(force ? ["/F"] : [])],
					{ stdio: "ignore", windowsHide: true },
				);
				const result = yield* Effect.race(
					Effect.callback<number | null>((resume) => {
						const error = () => resume(Effect.succeed(null));
						const close = (code: number | null) => resume(Effect.succeed(code));
						killer.once("error", error);
						killer.once("close", close);
						return Effect.sync(() => {
							killer.off("error", error);
							killer.off("close", close);
						});
					}),
					Effect.sleep(TASKKILL_GRACE_MS).pipe(Effect.as(undefined)),
				);
				if (result === 0) return;
				yield* Effect.try(() => killer.kill()).pipe(Effect.ignore);
				this.setProcessError(
					id,
					`taskkill ${result === undefined ? "timed out" : result === null ? "failed to start" : `exited with code ${result}`}; process tree termination may be incomplete`,
				);
				const latest = this.active(id);
				if (latest)
					yield* Effect.try(() => latest.terminal.child.kill(signal)).pipe(
						Effect.ignore,
					);
				return;
			}
			yield* Effect.try(() => {
				const current = this.active(id);
				if (!current) return;
				if (current.terminal.pid) process.kill(-current.terminal.pid, signal);
				else current.terminal.child.kill(signal);
			}).pipe(
				Effect.catch(() =>
					Effect.try(() => this.active(id)?.terminal.child.kill(signal)).pipe(
						Effect.ignore,
					),
				),
				Effect.asVoid,
			);
		},
	);

	private waitForSettlement = Effect.fn(
		"BackgroundTerminalManager.waitForSettlement",
	)(function* (
		settlement: Deferred.Deferred<SettledTerminalSnapshot>,
		timeoutMs: number,
	) {
		return yield* Effect.race(
			Deferred.await(settlement),
			Effect.sleep(timeoutMs),
		);
	});
	private terminate = Effect.fn("BackgroundTerminalManager.terminate")(
		function* (
			this: BackgroundTerminalManager,
			id: string,
			intent: TerminationIntent,
		): Effect.fn.Return<SettledTerminalSnapshot> {
			const current = this.entries.get(id);
			if (!current) throw new Error(`Unknown terminal id "${id}".`);
			if (current.kind === "settled") return current.snapshot;
			if (current.kind === "terminating") {
				const promotedIntent =
					intent === "shutdown"
						? "shutdown"
						: intent === "kill" && current.intent === "automatic"
							? "kill"
							: current.intent;
				if (promotedIntent !== current.intent)
					this.entries.set(id, { ...current, intent: promotedIntent });
				return yield* Deferred.await(current.terminal.settlement);
			}
			const settlement = current.terminal.settlement;
			this.entries.set(id, {
				kind: "terminating",
				terminal: current.terminal,
				intent,
			});
			yield* this.signalTree(id, false);
			yield* this.waitForSettlement(settlement, TERM_GRACE_MS);
			if (!this.active(id)) return yield* Deferred.await(settlement);
			yield* this.signalTree(id, true);
			yield* this.waitForSettlement(settlement, CLOSE_GRACE_MS);
			const active = this.active(id);
			if (!active) return yield* Deferred.await(settlement);
			this.setProcessError(
				id,
				active.terminal.processError ??
					"stdio did not close after termination; output may be incomplete",
			);
			const latest = this.active(id);
			if (!latest) return yield* Deferred.await(settlement);
			latest.terminal.child.stdout?.destroy();
			latest.terminal.child.stderr?.destroy();
			latest.terminal.child.stdio[NOTIFICATION_FD]?.destroy();
			latest.terminal.child.unref();
			const snapshot = this.settle(id);
			return snapshot ?? (yield* Deferred.await(settlement));
		},
		Effect.uninterruptible,
	);

	wait = Effect.fn("BackgroundTerminalManager.wait")(function* (
		this: BackgroundTerminalManager,
		id: string,
	) {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown terminal id "${id}".`);
		if (entry.kind === "settled") return entry.snapshot;
		// Observations replace the terminal record, but share this waiter counter.
		const terminal = entry.terminal;
		terminal.waiters.count++;
		return yield* Deferred.await(terminal.settlement).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					terminal.waiters.count--;
				}),
			),
		);
	});

	kill = Effect.fn("BackgroundTerminalManager.kill")(function* (
		this: BackgroundTerminalManager,
		ids: readonly string[],
	) {
		const unique = [...new Set(ids)];
		const entries = unique.map((id) => {
			const entry = this.entries.get(id);
			if (!entry) throw new Error(`Unknown terminal id "${id}".`);
			return { id, wasRunning: entry.kind !== "settled" };
		});
		const snapshots = yield* Effect.all(
			entries.map(({ id }) => this.terminate(id, "kill")),
			{ concurrency: "unbounded" },
		);
		return entries.map(({ id, wasRunning }, index) => {
			const snapshot = snapshots[index];
			return {
				id,
				title: snapshot.title,
				state: snapshot.state,
				wasRunning,
				killed: wasRunning && snapshot.state === "killed",
			};
		});
	});

	shutdown = Effect.fn("BackgroundTerminalManager.shutdown")(function* (
		this: BackgroundTerminalManager,
	) {
		const lifecycle = this.lifecycle;
		switch (lifecycle.kind) {
			case "stopping":
				return yield* Deferred.await(lifecycle.completion);
			case "stopped":
				return;
			case "running":
				break;
			default:
				return assertNever(lifecycle);
		}
		const completion = Deferred.makeUnsafe<void>();
		this.lifecycle = { kind: "stopping", completion };
		const manager = this;
		const exit = yield* Effect.exit(
			Effect.gen(function* () {
				yield* Effect.all(
					[...manager.entries.entries()]
						.filter(([, entry]) => entry.kind !== "settled")
						.map(([id]) => manager.terminate(id, "shutdown")),
					{ concurrency: "unbounded" },
				);
				manager.entries.clear();
				manager.lifecycle = { kind: "stopped" };
			}),
		);
		yield* Deferred.done(completion, exit);
		return yield* exit;
	}, Effect.uninterruptible);
}
