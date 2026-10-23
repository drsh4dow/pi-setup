import type { Caller } from "../src/auth.ts";
import { EVENT_TYPES, type WebhookEvent } from "../src/events.ts";
import type { HttpDeps } from "../src/http/replies.ts";
import type { ChargeRequest } from "../src/payments.ts";
import { DEMO_PLANS, PlanCatalog } from "../src/plans.ts";
import { err, ok } from "../src/result.ts";
import { BillingStore } from "../src/store.ts";
import { WebhookPublisher } from "../src/webhooks.ts";

export const NOW = new Date("2026-03-01T00:00:00.000Z");

export const TOKENS = new Map<string, Caller>([
  ["alice", { kind: "customer", customerId: "cus_alice" }],
  ["bob", { kind: "customer", customerId: "cus_bob" }],
  ["ada", { kind: "admin", adminId: "adm_ada" }],
]);

export type Delivery = { url: string; headers: Readonly<Record<string, string>>; body: string; event: WebhookEvent };

export type TestDeps = HttpDeps & {
  clock: { now(): Date; set(at: Date): void };
  /** Every charge the provider was asked for, in order. */
  charges: ChargeRequest[];
  /** Set to make the provider decline every charge. */
  declining: { value: boolean };
  /** Every webhook delivery attempt, in order. */
  deliveries: Delivery[];
  /** The status the webhook receiver answers. */
  receiverStatus: { value: number };
  logs: Record<string, unknown>[];
};

/**
 * Returns real billing dependencies around fakes for the edges: a settable clock starting at
 * NOW, sequential ids, a card provider that records charges, and one webhook endpoint
 * subscribed to every event whose deliveries are recorded. Tax is 10%.
 */
export function makeDeps(): TestDeps {
  let now = NOW;
  let nextId = 1;
  const store = new BillingStore();
  const charges: ChargeRequest[] = [];
  const declining = { value: false };
  const deliveries: Delivery[] = [];
  const receiverStatus = { value: 200 };
  const logs: Record<string, unknown>[] = [];
  const clock = { now: () => now, set: (at: Date) => void (now = at) };
  const log = (event: string, fields: Record<string, unknown>) => void logs.push({ event, ...fields });

  store.saveEndpoint({ id: "we_all", url: "https://hooks.example.com/billing", secret: "whsec_test", events: EVENT_TYPES, createdAt: NOW });

  return {
    store,
    plans: new PlanCatalog(DEMO_PLANS),
    payments: {
      async charge(request) {
        charges.push(request);
        if (declining.value) return err({ kind: "card_declined" });
        return ok({ chargeId: `ch_${charges.length}` });
      },
    },
    webhooks: new WebhookPublisher({
      store,
      clock,
      log,
      sleep: async () => {},
      transport: {
        async post(url, headers, body) {
          deliveries.push({ url, headers, body, event: JSON.parse(body) });
          return receiverStatus.value;
        },
      },
    }),
    clock,
    newId: () => `id_${nextId++}`,
    taxRateBasisPoints: 1_000,
    log,
    tokens: TOKENS,
    charges,
    declining,
    deliveries,
    receiverStatus,
    logs,
  };
}

/** Returns the types of the events delivered so far, in order. */
export function eventTypes(deps: TestDeps): string[] {
  return deps.deliveries.map((delivery) => delivery.event.type);
}
