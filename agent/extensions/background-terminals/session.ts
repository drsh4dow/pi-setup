import { Effect } from "effect";
import type { BackgroundTerminalDelivery } from "./delivery.ts";
import {
	BackgroundTerminalManager,
	MAX_RUNNING_PER_OWNER,
	type RunningTerminalSnapshot,
	type TerminalSnapshot,
} from "./manager.ts";

export interface TerminalClient {
	delivery: BackgroundTerminalDelivery;
	updateStatus: () => void;
}

export interface BackgroundTerminalSession {
	isOwner(id: symbol): boolean;
	start(
		client: symbol,
		options: { command: string; title: string; cwd: string },
	): RunningTerminalSnapshot;
	list(client: symbol): TerminalSnapshot[];
	get(client: symbol, id: string): TerminalSnapshot | undefined;
	kill(
		client: symbol,
		ids: readonly string[],
	): ReturnType<BackgroundTerminalManager["kill"]>;
	consume(ids: readonly string[]): void;
	leave(id: symbol): Effect.Effect<void>;
}

class SharedBackgroundTerminalSession implements BackgroundTerminalSession {
	// Every admitted delegate joins this parent-owned session. Aggregate admission is
	// intentionally unbounded, and parent shutdown clears every client.
	private readonly clients = new Map<symbol, TerminalClient>();
	private readonly owners = new Map<string, symbol>();
	private readonly manager: BackgroundTerminalManager;
	private readonly owner: symbol;
	private lifecycle: "running" | "stopping" = "running";

	constructor(owner: symbol, ownerClient: TerminalClient) {
		this.owner = owner;
		this.clients.set(owner, ownerClient);
		this.manager = new BackgroundTerminalManager(
			(snapshot, consumed) => {
				this.updateStatuses();
				if (consumed) {
					this.consume([snapshot.id]);
					return;
				}
				if (
					snapshot.state === "done" &&
					snapshot.stdout.totalBytes === 0 &&
					snapshot.stderr.totalBytes === 0 &&
					!snapshot.error
				)
					return;
				const holder = this.owners.get(snapshot.id);
				(holder ? this.clients.get(holder) : undefined)?.delivery.enqueue(
					snapshot,
				);
			},
			() => `bt-${++terminalSequence}`,
		);
	}

	join(id: symbol, client: TerminalClient) {
		if (this.lifecycle === "stopping")
			throw new Error("Background terminal session is shutting down.");
		this.clients.set(id, client);
		client.updateStatus();
	}

	isOwner(id: symbol) {
		return id === this.owner;
	}

	start(
		client: symbol,
		options: { command: string; title: string; cwd: string },
	) {
		const running = this.list(client).filter(
			(snapshot) => snapshot.state === "running",
		).length;
		if (running >= MAX_RUNNING_PER_OWNER) {
			throw new Error(
				`Max ${MAX_RUNNING_PER_OWNER} background terminals can run concurrently per session; this session is running ${running}. Kill one with bg_kill or wait for one to settle.`,
			);
		}
		const snapshot = this.manager.start(options);
		this.owners.set(snapshot.id, client);
		const tracked = new Set(this.manager.list().map((entry) => entry.id));
		for (const id of this.owners.keys())
			if (!tracked.has(id)) this.owners.delete(id);
		this.updateStatuses();
		return snapshot;
	}

	list(client: symbol) {
		return this.manager
			.list()
			.filter((snapshot) => this.owners.get(snapshot.id) === client);
	}

	get(client: symbol, id: string) {
		return this.owners.get(id) === client ? this.manager.get(id) : undefined;
	}

	kill(client: symbol, ids: readonly string[]) {
		for (const id of ids) {
			if (this.owners.get(id) !== client)
				throw new Error(`Unknown terminal id "${id}".`);
		}
		return this.manager.kill(ids);
	}

	consume(ids: readonly string[]) {
		for (const client of this.clients.values()) client.delivery.consume(ids);
	}

	private updateStatuses() {
		for (const client of this.clients.values()) client.updateStatus();
	}

	leave = Effect.fn("BackgroundTerminalSession.leave")(function* (
		this: SharedBackgroundTerminalSession,
		id: symbol,
	) {
		const client = this.clients.get(id);
		if (!client) return;
		client.delivery.clear();
		this.clients.delete(id);
		if (id !== this.owner) {
			const held = this.list(id);
			for (const snapshot of held) this.owners.delete(snapshot.id);
			yield* this.manager.kill(
				held
					.filter((snapshot) => snapshot.state === "running")
					.map((snapshot) => snapshot.id),
			);
			this.updateStatuses();
			return;
		}

		this.lifecycle = "stopping";
		if (activeTerminalSession === this) activeTerminalSession = undefined;
		for (const remaining of this.clients.values()) remaining.delivery.clear();
		this.clients.clear();
		this.owners.clear();
		yield* this.manager.shutdown();
	});
}

let activeTerminalSession: SharedBackgroundTerminalSession | undefined;
let terminalSequence = 0;

export function joinBackgroundTerminalSession(
	id: symbol,
	client: TerminalClient,
): BackgroundTerminalSession {
	if (!activeTerminalSession)
		activeTerminalSession = new SharedBackgroundTerminalSession(id, client);
	else activeTerminalSession.join(id, client);
	return activeTerminalSession;
}
