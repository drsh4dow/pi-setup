import { Effect } from "effect";
import type { BackgroundTerminalDelivery } from "./delivery.ts";
import {
	BackgroundTerminalManager,
	MAX_RUNNING_PER_OWNER,
	type RunningTerminalSnapshot,
	type TerminalSnapshot,
	terminalResultFields,
} from "./manager.ts";

export interface TerminalClient {
	delivery: BackgroundTerminalDelivery;
	updateStatus: () => void;
}

export interface BackgroundTerminalSession {
	start(
		client: symbol,
		options: { command: string; title: string; cwd: string },
	): RunningTerminalSnapshot;
	list(client: symbol): TerminalSnapshot[];
	get(client: symbol, id: string): TerminalSnapshot | undefined;
	wait(
		client: symbol,
		id: string,
	): ReturnType<BackgroundTerminalManager["wait"]>;
	kill(
		client: symbol,
		ids: readonly string[],
	): ReturnType<BackgroundTerminalManager["kill"]>;
	consume(client: symbol, ids: readonly string[]): void;
	leave(id: symbol): Effect.Effect<void>;
}

interface JoinedClient extends TerminalClient {
	manager: BackgroundTerminalManager;
}

class SharedBackgroundTerminalSession implements BackgroundTerminalSession {
	private readonly clients = new Map<symbol, JoinedClient>();
	private readonly owner: symbol;
	private lifecycle: "running" | "stopping" = "running";

	constructor(owner: symbol, ownerClient: TerminalClient) {
		this.owner = owner;
		this.join(owner, ownerClient);
	}

	join(id: symbol, client: TerminalClient) {
		if (this.lifecycle === "stopping")
			throw new Error("Background terminal session is shutting down.");
		const manager = new BackgroundTerminalManager(
			(snapshot, consumed) => {
				client.delivery.terminalSettled(snapshot.id);
				client.updateStatus();
				if (consumed) {
					client.delivery.consume([snapshot.id]);
					return;
				}
				if (
					snapshot.state === "done" &&
					snapshot.stdout.totalBytes === 0 &&
					snapshot.stderr.totalBytes === 0 &&
					!terminalResultFields(snapshot).error
				)
					return;
				client.delivery.enqueue(snapshot);
			},
			() => `bt-${++terminalSequence}`,
			(notification) => client.delivery.enqueueNotification(notification),
		);
		this.clients.set(id, { ...client, manager });
		client.updateStatus();
	}

	private joined(client: symbol): JoinedClient {
		const joined = this.clients.get(client);
		if (!joined)
			throw new Error("Background terminal session is shutting down.");
		return joined;
	}

	start(
		client: symbol,
		options: { command: string; title: string; cwd: string },
	) {
		const joined = this.joined(client);
		const running = joined.manager
			.list()
			.filter((snapshot) => snapshot.state === "running").length;
		if (running >= MAX_RUNNING_PER_OWNER) {
			throw new Error(
				`Max ${MAX_RUNNING_PER_OWNER} background terminals can run concurrently per session; this session is running ${running}. Kill one with bg_kill or use bg_wait with its id.`,
			);
		}
		const snapshot = joined.manager.start(options);
		joined.updateStatus();
		return snapshot;
	}

	list(client: symbol) {
		return this.clients.get(client)?.manager.list() ?? [];
	}

	get(client: symbol, id: string) {
		return this.clients.get(client)?.manager.get(id);
	}

	wait(client: symbol, id: string) {
		return this.joined(client).manager.wait(id);
	}

	kill(client: symbol, ids: readonly string[]) {
		return this.joined(client).manager.kill(ids);
	}

	consume(client: symbol, ids: readonly string[]) {
		this.clients.get(client)?.delivery.consume(ids);
	}

	leave = Effect.fn("BackgroundTerminalSession.leave")(function* (
		this: SharedBackgroundTerminalSession,
		id: symbol,
	) {
		const joined = this.clients.get(id);
		if (!joined) return;
		if (id !== this.owner) {
			joined.delivery.clear();
			yield* joined.manager.shutdown();
			if (this.clients.get(id) === joined) this.clients.delete(id);
			return;
		}

		this.lifecycle = "stopping";
		if (activeTerminalSession === this) activeTerminalSession = undefined;
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const client of clients) client.delivery.clear();
		yield* Effect.all(
			clients.map((client) => client.manager.shutdown()),
			{
				concurrency: "unbounded",
			},
		);
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
