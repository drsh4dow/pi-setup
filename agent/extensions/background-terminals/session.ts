import { Effect } from "effect";
import type { BackgroundTerminalDelivery } from "./delivery.ts";
import {
  BackgroundTerminalManager,
  type RunningTerminalSnapshot,
  type SettledTerminalSnapshot,
  type TerminalMetadata,
  type TerminalSnapshot,
} from "./manager.ts";

interface PendingKillResult {
  calls: number;
  snapshot: SettledTerminalSnapshot | undefined;
}

export type AbandonedKillOutcome = "delivered" | "awaited" | "ended" | "closed";

interface TerminalClient {
  delivery: BackgroundTerminalDelivery;
  updateStatus: () => void;
}

export interface BackgroundTerminalSession {
  start(options: { command: string; title: string; cwd: string }): RunningTerminalSnapshot;
  list(): TerminalMetadata[];
  get(id: string): TerminalSnapshot | undefined;
  kill(ids: readonly string[]): ReturnType<BackgroundTerminalManager["kill"]>;
  consume(ids: readonly string[]): void;
  abandonKill(ids: readonly string[]): ReadonlyMap<string, AbandonedKillOutcome>;
  readonly leave: Effect.Effect<void>;
}

class SharedBackgroundTerminalSession {
  private readonly clients = new Map<TerminalClient, BackgroundTerminalManager>();
  private readonly owner: TerminalClient;
  private lifecycle: "running" | "stopping" = "running";

  constructor(owner: TerminalClient) {
    this.owner = owner;
  }

  join(client: TerminalClient): BackgroundTerminalSession {
    if (this.lifecycle === "stopping")
      throw new Error("Background terminal session is shutting down.");

    const pendingKillResults = new Map<string, PendingKillResult>();

    const manager = new BackgroundTerminalManager(
      (snapshot) => {
        const wait = pendingKillResults.get(snapshot.id);

        if (wait) wait.snapshot = snapshot;
        else client.delivery.enqueue(snapshot);

        client.updateStatus();
      },
      () => `bt-${++terminalSequence}`,
      (notification) => client.delivery.enqueueNotification(notification),
    );

    this.clients.set(client, manager);
    client.updateStatus();

    const current = () => {
      if (this.clients.get(client) !== manager)
        throw new Error("Background terminal session is shutting down.");

      return manager;
    };

    return {
      start: (options) => {
        const snapshot = current().start(options);
        client.updateStatus();

        return snapshot;
      },
      list: () => this.clients.get(client)?.list() ?? [],
      get: (id) => this.clients.get(client)?.get(id),
      kill: (ids) =>
        Effect.suspend(() => {
          const terminals = current();

          for (const id of new Set(ids)) {
            const wait = pendingKillResults.get(id);

            if (wait) wait.calls++;
            else pendingKillResults.set(id, { calls: 1, snapshot: undefined });
          }

          return terminals.kill(ids);
        }),
      consume: (ids) => {
        if (!this.clients.has(client)) return;

        for (const id of ids) pendingKillResults.delete(id);
        client.delivery.consume(ids);
      },
      abandonKill: (ids) => {
        const terminals = this.clients.get(client);

        if (!terminals) return new Map(ids.map((id) => [id, "closed"]));

        const outcomes = new Map<string, AbandonedKillOutcome>();

        for (const id of new Set(ids)) {
          const wait = pendingKillResults.get(id);

          if (!wait) {
            outcomes.set(id, "awaited");
            continue;
          }

          wait.calls -= 1;

          if (wait.calls > 0) {
            outcomes.set(id, "awaited");
            continue;
          }

          pendingKillResults.delete(id);

          if (wait.snapshot) client.delivery.enqueue(wait.snapshot);

          const settlesLater = terminals.get(id)?.state === "running";
          outcomes.set(id, wait.snapshot || settlesLater ? "delivered" : "ended");
        }

        return outcomes;
      },
      leave: Effect.suspend(() => this.leave(client)),
    };
  }

  private leave = Effect.fn("BackgroundTerminalSession.leave")(function* (
    this: SharedBackgroundTerminalSession,
    client: TerminalClient,
  ) {
    const manager = this.clients.get(client);

    if (!manager) return;

    if (client !== this.owner) {
      client.delivery.clear();
      yield* manager.shutdown();

      if (this.clients.get(client) === manager) this.clients.delete(client);

      return;
    }

    this.lifecycle = "stopping";

    if (activeTerminalSession === this) activeTerminalSession = undefined;
    const clients = [...this.clients];
    this.clients.clear();

    for (const [joined] of clients) joined.delivery.clear();
    yield* Effect.forEach(clients, ([, joinedManager]) => joinedManager.shutdown(), {
      concurrency: "unbounded",
    });
  });
}

let activeTerminalSession: SharedBackgroundTerminalSession | undefined;

let terminalSequence = 0;

export function joinBackgroundTerminalSession(
  delivery: BackgroundTerminalDelivery,
  updateStatus: () => void,
): BackgroundTerminalSession {
  const client = { delivery, updateStatus };
  activeTerminalSession ??= new SharedBackgroundTerminalSession(client);

  return activeTerminalSession.join(client);
}
