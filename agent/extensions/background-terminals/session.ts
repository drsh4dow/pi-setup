import { Effect } from "effect";
import type { BackgroundTerminalDelivery } from "./delivery.ts";
import {
  BackgroundTerminalManager,
  type RunningTerminalSnapshot,
  type SettledTerminalSnapshot,
  type TerminalMetadata,
  type TerminalSnapshot,
} from "./manager.ts";

type KillWait = { kind: "waiting" } | { kind: "settled"; snapshot: SettledTerminalSnapshot };

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
  abandonKill(ids: readonly string[]): void;
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

    // A bg_kill call waiting on a terminal reports its end in the tool result.
    const killWaits = new Map<string, KillWait>();

    const manager = new BackgroundTerminalManager(
      (snapshot) => {
        client.delivery.terminalSettled(snapshot.id);
        client.updateStatus();

        if (killWaits.has(snapshot.id)) {
          killWaits.set(snapshot.id, { kind: "settled", snapshot });

          return;
        }

        client.delivery.enqueue(snapshot);
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
      kill: (ids) => {
        const terminals = current();

        for (const id of ids) {
          if (!killWaits.has(id)) killWaits.set(id, { kind: "waiting" });
        }

        return terminals.kill(ids);
      },
      consume: (ids) => {
        if (!this.clients.has(client)) return;

        for (const id of ids) killWaits.delete(id);
        client.delivery.consume(ids);
      },
      abandonKill: (ids) => {
        if (!this.clients.has(client)) return;

        for (const id of ids) {
          const wait = killWaits.get(id);
          killWaits.delete(id);

          if (wait?.kind === "settled") client.delivery.enqueue(wait.snapshot);
        }
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
