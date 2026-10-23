import { createHmac } from "node:crypto";
import type { EventType, WebhookEvent } from "./events.ts";
import type { BillingStore } from "./store.ts";

export type WebhookEndpoint = {
  id: string;
  url: string;
  /** Signs deliveries. Shown once, in the response that creates the endpoint. */
  secret: string;
  events: readonly EventType[];
  createdAt: Date;
};

/** Sends one HTTP POST and resolves to the response status. Rejects on a network failure. */
export type Transport = { post(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<number> };

export const MAX_ATTEMPTS = 3;

/**
 * Returns the `billing-signature` header for `body` sent at `timestamp` (Unix seconds):
 * `t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<body>" under secret>`.
 */
export function signatureHeader(secret: string, timestamp: number, body: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

type PublisherDeps = {
  store: BillingStore;
  transport: Transport;
  clock: { now(): Date };
  log(event: string, fields: Record<string, unknown>): void;
  sleep(ms: number): Promise<void>;
};

/** Delivers events to the endpoints subscribed to them. See docs/webhooks.md for the guarantees. */
export class WebhookPublisher {
  readonly #deps: PublisherDeps;

  constructor(deps: PublisherDeps) {
    this.#deps = deps;
  }

  /**
   * Delivers `event` to every endpoint subscribed to its type, one endpoint at a time, trying
   * each up to MAX_ATTEMPTS times. Resolves once each delivery succeeded or ran out of
   * attempts; a failed delivery is logged, never thrown.
   */
  async publish(event: WebhookEvent): Promise<void> {
    const body = JSON.stringify(event);
    for (const endpoint of this.#deps.store.endpoints()) {
      if (!endpoint.events.includes(event.type)) continue;
      await this.#deliver(endpoint, event, body);
    }
  }

  async #deliver(endpoint: WebhookEndpoint, event: WebhookEvent, body: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const timestamp = Math.floor(this.#deps.clock.now().getTime() / 1000);
      const headers = {
        "content-type": "application/json",
        "billing-event-id": event.id,
        "billing-signature": signatureHeader(endpoint.secret, timestamp, body),
      };
      const status = await this.#deps.transport.post(endpoint.url, headers, body).catch(() => 0);
      if (status >= 200 && status < 300) return;

      this.#deps.log("webhook_delivery_failed", { endpointId: endpoint.id, eventId: event.id, attempt, status });
      if (attempt < MAX_ATTEMPTS) await this.#deps.sleep(1000 * 2 ** attempt);
    }
  }
}
