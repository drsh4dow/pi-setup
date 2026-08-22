import { Clock, Config, Deferred, Effect } from "effect";
import { sacrificeKillNote, tagCommand } from "../../lib/sacrifice.ts";

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

type SettledTerminalState = "done" | "failed" | "killed";
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
	exitCode?: number;
	signal?: string;
	error?: string;
	stdout: OutputTail;
	stderr: OutputTail;
}
export type RunningTerminalSnapshot = TerminalSnapshotBase & {
	state: "running";
	settledAt?: never;
};
export type SettledTerminalSnapshot = TerminalSnapshotBase & {
	state: SettledTerminalState;
	settledAt: number;
};
export type TerminalSnapshot =
	| RunningTerminalSnapshot
	| SettledTerminalSnapshot;

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

type ProcessExit =
	| { kind: "code"; code: number }
	| { kind: "signal"; signal: string }
	| { kind: "unknown" };
type ProcessObservation =
	| { kind: "executing" }
	| { kind: "draining-after-exit"; exit: ProcessExit }
	| { kind: "reaping-after-pipe-close"; exit: ProcessExit };
type TerminationPhase = "graceful" | "forceful" | "closing-pipes";
type TerminationIntent = "automatic" | "kill";

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
	observation: ProcessObservation;
	processError?: string;
	settlement: Deferred.Deferred<void>;
}
type ActiveEntry =
	| { kind: "running"; terminal: ActiveTerminal }
	| {
			kind: "terminating";
			terminal: ActiveTerminal;
			intent: TerminationIntent;
			phase: TerminationPhase;
	  };
type Entry =
	| ActiveEntry
	| { kind: "settled"; snapshot: SettledTerminalSnapshot };

function assertNever(value: never): never {
	throw new Error(`Unexpected terminal lifecycle variant: ${String(value)}`);
}
function processExit(
	code: number | null,
	signal: NodeJS.Signals | null,
): ProcessExit {
	if (signal !== null) return { kind: "signal", signal };
	if (code !== null) return { kind: "code", code };
	return { kind: "unknown" };
}
function exitSnapshot(exit: ProcessExit): {
	exitCode: number | undefined;
	signal: string | undefined;
} {
	switch (exit.kind) {
		case "code":
			return { exitCode: exit.code, signal: undefined };
		case "signal":
			return { exitCode: undefined, signal: exit.signal };
		case "unknown":
			return { exitCode: undefined, signal: undefined };
		default:
			return assertNever(exit);
	}
}
function observedExit(observation: ProcessObservation): {
	exitCode: number | undefined;
	signal: string | undefined;
} {
	switch (observation.kind) {
		case "executing":
			return { exitCode: undefined, signal: undefined };
		case "draining-after-exit":
		case "reaping-after-pipe-close":
			return exitSnapshot(observation.exit);
		default:
			return assertNever(observation);
	}
}

export class BackgroundTerminalManager {
	private readonly entries = new Map<string, Entry>();
	private counter = 0;
	private lifecycle: "running" | "stopping" | "stopped" = "running";
	private readonly onSettled?: (
		snapshot: SettledTerminalSnapshot,
		consumed: boolean,
	) => void;
	private readonly allocateId: () => string;
	constructor(
		onSettled?: (snapshot: SettledTerminalSnapshot, consumed: boolean) => void,
		allocateId?: () => string,
	) {
		this.onSettled = onSettled;
		this.allocateId = allocateId ?? (() => `bt-${++this.counter}`);
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
		return {
			id: terminal.id,
			command: terminal.command,
			title: terminal.title,
			cwd: terminal.cwd,
			pid: terminal.pid,
			state: "running",
			createdAt: terminal.createdAt,
			...observedExit(terminal.observation),
			...(terminal.processError ? { error: terminal.processError } : {}),
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
		if (this.lifecycle !== "running")
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
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
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
			observation: { kind: "executing" },
			settlement: Deferred.makeUnsafe<void>(),
		};
		const entry: Entry = { kind: "running", terminal };
		this.entries.set(id, entry);
		child.stdout?.on("data", (chunk: Buffer) =>
			this.appendOutput(id, "stdout", chunk),
		);
		child.stderr?.on("data", (chunk: Buffer) =>
			this.appendOutput(id, "stderr", chunk),
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
						phase: entry.phase,
					},
		);
	}
	private appendOutput(id: string, stream: "stdout" | "stderr", chunk: Buffer) {
		const entry = this.active(id);
		if (entry) entry.terminal[stream].append(chunk);
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

	private settle(id: string) {
		const entry = this.active(id);
		if (!entry) return;
		const terminal = entry.terminal;
		const exit = observedExit(terminal.observation);
		let error = terminal.processError;
		if (entry.kind === "running" && !error) {
			const note = sacrificeKillNote(exit, terminal.createdAt);
			if (note) error = note;
		}
		const state: SettledTerminalState =
			entry.kind === "terminating" && entry.intent === "kill"
				? "killed"
				: error || exit.exitCode !== 0
					? "failed"
					: "done";
		const snapshot: SettledTerminalSnapshot = {
			id: terminal.id,
			command: terminal.command,
			title: terminal.title,
			cwd: terminal.cwd,
			pid: terminal.pid,
			state,
			createdAt: terminal.createdAt,
			settledAt: Effect.runSync(Clock.currentTimeMillis),
			...exit,
			...(error ? { error } : {}),
			stdout: terminal.stdout.view(),
			stderr: terminal.stderr.view(),
		};
		this.entries.set(id, { kind: "settled", snapshot });
		try {
			if (this.lifecycle === "running")
				this.onSettled?.(
					snapshot,
					entry.kind === "terminating" && entry.intent === "kill",
				);
		} catch {
			// Notification failures do not own process lifecycle state.
		}
		this.prune();
		Effect.runSync(Deferred.succeed(terminal.settlement, undefined));
	}

	private setProcessError(id: string, message: string) {
		const entry = this.active(id);
		if (!entry) return;
		this.replaceTerminal(entry, {
			...entry.terminal,
			processError: message,
		});
	}
	private signalTree(id: string, force: boolean): Effect.Effect<void> {
		const entry = this.active(id);
		if (!entry) return Effect.void;
		const signal = force ? "SIGKILL" : "SIGTERM";
		if (process.platform === "win32" && entry.terminal.pid) {
			const self = this;
			return Effect.gen(function* () {
				const current = self.active(id);
				if (!current?.terminal.pid) return;
				const killer = spawn(
					"taskkill",
					[
						"/pid",
						String(current.terminal.pid),
						"/T",
						...(force ? ["/F"] : []),
					],
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
				self.setProcessError(
					id,
					`taskkill ${result === undefined ? "timed out" : result === null ? "failed to start" : `exited with code ${result}`}; process tree termination may be incomplete`,
				);
				const latest = self.active(id);
				if (latest)
					yield* Effect.try(() => latest.terminal.child.kill(signal)).pipe(
						Effect.ignore,
					);
			});
		}
		return Effect.try(() => {
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
	}

	private waitForSettlement(
		settlement: Deferred.Deferred<void>,
		timeoutMs: number,
	) {
		return Effect.race(Deferred.await(settlement), Effect.sleep(timeoutMs));
	}
	private setTerminationPhase(id: string, phase: TerminationPhase) {
		const entry = this.entries.get(id);
		if (entry?.kind !== "terminating") return;
		this.entries.set(id, { ...entry, phase });
	}
	private terminate(
		id: string,
		intent: TerminationIntent,
	): Effect.Effect<void> {
		const current = this.entries.get(id);
		if (!current || current.kind === "settled") return Effect.void;
		if (current.kind === "terminating") {
			if (intent === "kill" && current.intent === "automatic")
				this.entries.set(id, { ...current, intent: "kill" });
			return Deferred.await(current.terminal.settlement);
		}
		const settlement = current.terminal.settlement;
		this.entries.set(id, {
			kind: "terminating",
			terminal: current.terminal,
			intent,
			phase: "graceful",
		});
		const self = this;
		return Effect.gen(function* () {
			yield* self.signalTree(id, false);
			yield* self.waitForSettlement(settlement, TERM_GRACE_MS);
			if (!self.active(id)) return;
			self.setTerminationPhase(id, "forceful");
			yield* self.signalTree(id, true);
			yield* self.waitForSettlement(settlement, CLOSE_GRACE_MS);
			const active = self.active(id);
			if (!active) return;
			self.setTerminationPhase(id, "closing-pipes");
			self.setProcessError(
				id,
				active.terminal.processError ??
					"stdio did not close after termination; output may be incomplete",
			);
			const latest = self.active(id);
			if (!latest) return;
			latest.terminal.child.stdout?.destroy();
			latest.terminal.child.stderr?.destroy();
			latest.terminal.child.unref();
			self.settle(id);
		}).pipe(Effect.uninterruptible);
	}

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
		yield* Effect.all(
			entries.map(({ id }) => this.terminate(id, "kill")),
			{ concurrency: "unbounded" },
		);
		return entries.map(({ id, wasRunning }) => {
			const snapshot = this.get(id);
			if (!snapshot) throw new Error(`Unknown terminal id "${id}".`);
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
		if (this.lifecycle !== "running") return;
		this.lifecycle = "stopping";
		yield* Effect.all(
			[...this.entries.entries()]
				.filter(([, entry]) => entry.kind !== "settled")
				.map(([id]) => this.terminate(id, "kill")),
			{ concurrency: "unbounded" },
		);
		this.entries.clear();
		this.lifecycle = "stopped";
	});
}
