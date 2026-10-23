import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { publishSubscription } from "../src/billing.ts";
import { startSubscription } from "../src/subscriptions.ts";
import { MAX_ATTEMPTS } from "../src/webhooks.ts";
import { makeDeps, NOW } from "./helpers.ts";

function subscription(deps: ReturnType<typeof makeDeps>) {
  return startSubscription({ id: "sub_1", customerId: "cus_alice", plan: deps.plans.get("pro")!, at: NOW });
}

test("a delivery is signed over its timestamp and raw body", async () => {
  const deps = makeDeps();
  await publishSubscription(deps, "subscription.created", subscription(deps), NOW);

  const [delivery] = deps.deliveries;
  assert.ok(delivery);
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(delivery.headers["billing-signature"] ?? "") ?? [];
  assert.equal(t, String(NOW.getTime() / 1000));
  assert.equal(v1, createHmac("sha256", "whsec_test").update(`${t}.${delivery.body}`).digest("hex"));
  assert.equal(delivery.headers["billing-event-id"], delivery.event.id);
});

test("an event carries its payload version and the subscription as it is", async () => {
  const deps = makeDeps();
  await publishSubscription(deps, "subscription.created", subscription(deps), NOW);

  const event = deps.deliveries[0]?.event;
  assert.equal(event?.version, 3);
  assert.equal(event?.data.planId, "pro");
  assert.equal(event?.data.scheduledPlanId, null);
  assert.equal(event?.data.status, "trialing");
  assert.equal(event?.data.currentPeriodEnd, "2026-03-15T00:00:00.000Z");
});

test("a failing endpoint is retried, then given up on with a log line per attempt", async () => {
  const deps = makeDeps();
  deps.receiverStatus.value = 503;

  await publishSubscription(deps, "subscription.created", subscription(deps), NOW);

  assert.equal(deps.deliveries.length, MAX_ATTEMPTS);
  assert.deepEqual(
    deps.logs.map((entry) => [entry.event, entry.endpointId, entry.attempt]),
    [1, 2, 3].map((attempt) => ["webhook_delivery_failed", "we_all", attempt]),
  );
});

test("an endpoint only gets the event types it subscribed to", async () => {
  const deps = makeDeps();
  deps.store.saveEndpoint({ ...deps.store.getEndpoint("we_all")!, events: ["invoice.paid"] });
  await publishSubscription(deps, "subscription.created", subscription(deps), NOW);
  assert.deepEqual(deps.deliveries, []);
});
