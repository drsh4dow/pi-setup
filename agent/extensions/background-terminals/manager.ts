import { Clock, Effect } from "effect";

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

export type TerminalState = "running" | "done" | "failed" | "killed";
export interface OutputTail {
	text: string;
	totalBytes: number;
	truncatedBytes: number;
}
export interface TerminalSnapshot {
	id: string;
	command: string;
	title: string;
	cwd: string;
	pid?: number;
	state: TerminalState;
	createdAt: number;
	settledAt?: number;
	exitCode?: number;
	signal?: string;
	error?: string;
	stdout: OutputTail;
	stderr: OutputTail;
}
export interface KillResult {
	id: string;
	title: string;
	state: TerminalState;
	wasRunning: boolean;
	killed: boolean;
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

interface Entry {
	snapshot: Omit<TerminalSnapshot, "stdout" | "stderr">;
	child: ChildProcess;
	stdout: Tail;
	stderr: Tail;
	exited: boolean;
	closed: boolean;
	killSignaled: boolean;
	pipeGeneration: number;
	groupGeneration: number;
	termination?: Promise<void>;
	settled: Promise<void>;
	resolveSettled: () => void;
}

export class BackgroundTerminalManager {
	private readonly entries = new Map<string, Entry>();
	private counter = 0;
	private lifecycle: "running" | "stopping" | "stopped" = "running";
	private readonly killInterest = new Map<string, number>();
	private readonly onSettled?: (
		snapshot: TerminalSnapshot,
		consumed: boolean,
	) => void;
	private readonly allocateId: () => string;
	constructor(
		onSettled?: (snapshot: TerminalSnapshot, consumed: boolean) => void,
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
		return {
			...entry.snapshot,
			stdout: entry.stdout.view(),
			stderr: entry.stderr.view(),
		};
	}
	private prune(limit = MAX_TRACKED) {
		while (this.entries.size > limit) {
			const oldest = [...this.entries.values()]
				.filter((entry) => entry.snapshot.state !== "running")
				.sort(
					(a, b) => (a.snapshot.settledAt ?? 0) - (b.snapshot.settledAt ?? 0),
				)[0];
			if (!oldest) return;
			this.entries.delete(oldest.snapshot.id);
		}
	}

	start(options: {
		command: string;
		title: string;
		cwd: string;
	}): TerminalSnapshot {
		if (this.lifecycle !== "running")
			throw new Error("Background terminal manager is shutting down.");
		this.prune(MAX_TRACKED - 1);
		const invocation =
			process.platform === "win32"
				? {
						file: process.env.ComSpec ?? "cmd.exe",
						args: ["/d", "/s", "/c", options.command],
					}
				: { file: "/bin/sh", args: ["-c", options.command] };
		const child = spawn(invocation.file, invocation.args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		const id = this.allocateId();
		let resolveSettled = () => {};
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		const entry: Entry = {
			snapshot: {
				id,
				command: options.command,
				title: options.title,
				cwd: options.cwd,
				pid: child.pid,
				state: "running",
				createdAt: Effect.runSync(Clock.currentTimeMillis),
			},
			child,
			stdout: new Tail(),
			stderr: new Tail(),
			exited: false,
			closed: false,
			killSignaled: false,
			pipeGeneration: 0,
			groupGeneration: 0,
			settled,
			resolveSettled,
		};
		this.entries.set(id, entry);
		child.stdout?.on("data", (chunk: Buffer) => entry.stdout.append(chunk));
		child.stderr?.on("data", (chunk: Buffer) => entry.stderr.append(chunk));
		child.once("error", (error) => {
			entry.snapshot.error = String(error.message).slice(0, 4096);
		});
		child.once("exit", (code, signal) => {
			entry.exited = true;
			entry.snapshot.exitCode = code ?? undefined;
			entry.snapshot.signal = signal ?? undefined;
			const generation = ++entry.pipeGeneration;
			void Effect.runPromise(Effect.sleep(PIPE_GRACE_MS)).then(() => {
				if (
					entry.pipeGeneration === generation &&
					!entry.closed &&
					entry.snapshot.state === "running"
				)
					void this.terminate(entry, false);
			});
		});
		child.once("close", (code, signal) => {
			entry.closed = true;
			entry.pipeGeneration++;
			entry.snapshot.exitCode ??= code ?? undefined;
			entry.snapshot.signal ??= signal ?? undefined;
			this.settleWhenProcessGroupExits(entry);
		});
		return this.snapshot(entry);
	}

	private processGroupExists(entry: Entry): boolean {
		if (process.platform === "win32" || !entry.child.pid) return false;
		try {
			process.kill(-entry.child.pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	private settleWhenProcessGroupExits(entry: Entry) {
		if (entry.snapshot.state !== "running") return;
		if (!this.processGroupExists(entry)) {
			this.settle(entry);
			return;
		}
		const generation = ++entry.groupGeneration;
		void Effect.runPromise(Effect.sleep(GROUP_CHECK_MS)).then(() => {
			if (entry.groupGeneration === generation)
				this.settleWhenProcessGroupExits(entry);
		});
	}

	private settle(entry: Entry) {
		if (entry.snapshot.state !== "running") return;
		entry.pipeGeneration++;
		entry.groupGeneration++;
		entry.snapshot.state = entry.killSignaled
			? "killed"
			: entry.snapshot.error || entry.snapshot.exitCode !== 0
				? "failed"
				: "done";
		entry.snapshot.settledAt = Effect.runSync(Clock.currentTimeMillis);
		entry.resolveSettled();
		const snapshot = this.snapshot(entry);
		try {
			if (this.lifecycle === "running")
				this.onSettled?.(
					snapshot,
					(this.killInterest.get(snapshot.id) ?? 0) > 0,
				);
		} catch {
			// Notification failures do not own process lifecycle state.
		}
		this.prune();
	}

	private async signalTree(entry: Entry, force: boolean): Promise<void> {
		if (process.platform === "win32" && entry.child.pid) {
			const killer = spawn(
				"taskkill",
				["/pid", String(entry.child.pid), "/T", ...(force ? ["/F"] : [])],
				{ stdio: "ignore", windowsHide: true },
			);
			const result = await Promise.race([
				new Promise<number | null>((resolve) => {
					killer.once("error", () => resolve(null));
					killer.once("close", resolve);
				}),
				new Promise<undefined>(
					(resolve) =>
						void Effect.runPromise(Effect.sleep(TASKKILL_GRACE_MS)).then(() =>
							resolve(undefined),
						),
				),
			]);
			if (result === 0) return;
			try {
				killer.kill();
			} catch {}
			entry.snapshot.error = `taskkill ${result === undefined ? "timed out" : result === null ? "failed to start" : `exited with code ${result}`}; process tree termination may be incomplete`;
			try {
				entry.child.kill(force ? "SIGKILL" : "SIGTERM");
			} catch {}
			return;
		}
		try {
			if (entry.child.pid)
				process.kill(-entry.child.pid, force ? "SIGKILL" : "SIGTERM");
			else entry.child.kill(force ? "SIGKILL" : "SIGTERM");
		} catch {
			try {
				entry.child.kill(force ? "SIGKILL" : "SIGTERM");
			} catch {}
		}
	}

	private async waitForSettlement(entry: Entry, timeoutMs: number) {
		await Effect.runPromise(
			Effect.race(
				Effect.promise(() => entry.settled),
				Effect.sleep(timeoutMs),
			),
		);
	}

	private terminate(entry: Entry, owned: boolean): Promise<void> {
		if (entry.termination) return entry.termination;
		entry.termination = (async () => {
			if (entry.snapshot.state !== "running") return;
			if (owned) entry.killSignaled = true;
			await this.signalTree(entry, false);
			await this.waitForSettlement(entry, TERM_GRACE_MS);
			if (entry.snapshot.state === "running") {
				await this.signalTree(entry, true);
				await this.waitForSettlement(entry, CLOSE_GRACE_MS);
			}
			if (entry.snapshot.state === "running") {
				entry.snapshot.error ??=
					"stdio did not close after termination; output may be incomplete";
				entry.child.stdout?.destroy();
				entry.child.stderr?.destroy();
				entry.child.unref();
				this.settle(entry);
			}
		})();
		return entry.termination;
	}

	async kill(ids: readonly string[]): Promise<KillResult[]> {
		const unique = [...new Set(ids)];
		const entries = unique.map((id) => {
			const entry = this.entries.get(id);
			if (!entry) throw new Error(`Unknown terminal id "${id}".`);
			return entry;
		});
		const wasRunning = new Set(
			entries
				.filter((entry) => entry.snapshot.state === "running")
				.map((entry) => entry.snapshot.id),
		);
		for (const id of wasRunning)
			this.killInterest.set(id, (this.killInterest.get(id) ?? 0) + 1);
		try {
			await Promise.all(entries.map((entry) => this.terminate(entry, true)));
			return entries.map((entry) => ({
				id: entry.snapshot.id,
				title: entry.snapshot.title,
				state: entry.snapshot.state,
				wasRunning: wasRunning.has(entry.snapshot.id),
				killed:
					wasRunning.has(entry.snapshot.id) &&
					entry.snapshot.state === "killed",
			}));
		} finally {
			for (const id of wasRunning) {
				const count = (this.killInterest.get(id) ?? 1) - 1;
				if (count === 0) this.killInterest.delete(id);
				else this.killInterest.set(id, count);
			}
		}
	}

	async shutdown(): Promise<void> {
		if (this.lifecycle !== "running") return;
		this.lifecycle = "stopping";
		await Promise.all(
			[...this.entries.values()]
				.filter((entry) => entry.snapshot.state === "running")
				.map((entry) => this.terminate(entry, true)),
		);
		this.entries.clear();
		this.lifecycle = "stopped";
	}
}
