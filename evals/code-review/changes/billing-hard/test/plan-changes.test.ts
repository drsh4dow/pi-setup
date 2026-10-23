import assert from "node:assert/strict";
import { test } from "node:test";
import { renewDue } from "../src/billing.ts";
import { renew, startSubscription } from "../src/subscriptions.ts";
import { NOW } from "./helpers.ts";
import { startApp } from "./http-helpers.ts";

const { request, deps } = await startApp();

const MAR_15 = new Date("2026-03-15T00:00:00.000Z");
const APR_15 = new Date("2026-04-15T00:00:00.000Z");

/**
 * Saves an active subscription of alice's on `planId` whose trial ended on Mar 15, so its
 * current period runs Mar 15 to Apr 15, 31 days, and returns its id.
 */
function activeSubscription(planId: string): string {
  const plan = deps.plans.get(planId);
  assert.ok(plan);
  const renewed = renew(startSubscription({ id: deps.newId(), customerId: "cus_alice", plan, at: NOW }), plan);
  assert.ok(renewed.ok);
  assert.equal(renewed.value.currentPeriodEnd.toISOString(), APR_15.toISOString());
  deps.store.saveSubscription(renewed.value);
  return renewed.value.id;
}

function changePlan(id: string, planId: string, token = "alice") {
  return request("POST", `/subscriptions/${id}/plan`, { token, body: { planId } });
}

test("an upgrade switches plan now and charges the prorated difference", async () => {
  const id = activeSubscription("starter");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));
  const chargesBefore = deps.charges.length;

  const { status, body } = await changePlan(id, "pro");

  assert.equal(status, 200);
  assert.equal(body.subscription.planId, "pro");
  assert.equal(body.subscription.status, "active");
  assert.equal(body.invoice.status, "paid");
  assert.match(body.invoice.number, /^INV-\d{6}$/);
  assert.equal(body.invoice.billingReason, "plan_change");
  assert.deepEqual(
    body.invoice.lines.map((line: { kind: string; amountCents: number }) => [line.kind, line.amountCents]),
    [
      ["proration_credit", -516],
      ["proration_charge", 1_600],
    ],
  );
  assert.equal(body.invoice.totalCents, 1_192);
  assert.deepEqual(deps.charges.slice(chargesBefore).map((charge) => charge.amountCents), [1_192]);
  assert.equal(deps.store.getSubscription(id)?.planId, "pro");
});

test("an upgrade announces the switch and the invoice", async () => {
  const id = activeSubscription("starter");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));
  const deliveredBefore = deps.deliveries.length;

  const { body } = await changePlan(id, "pro");

  const events = deps.deliveries.slice(deliveredBefore).map((delivery) => delivery.event);
  assert.deepEqual(
    events.map((event) => event.type),
    ["subscription.updated", "invoice.finalized", "invoice.paid"],
  );
  assert.equal(events[0]?.data.planId, "pro");
  assert.equal(events[1]?.data.id, body.invoice.id);
  assert.equal(events[1]?.data.billingReason, "plan_change");
});

test("a downgrade keeps the plan until the renewal and charges nothing now", async () => {
  const id = activeSubscription("pro");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));
  const chargesBefore = deps.charges.length;

  const { status, body } = await changePlan(id, "starter");

  assert.equal(status, 200);
  assert.equal(body.invoice, null);
  assert.equal(body.subscription.planId, "pro");
  assert.equal(body.subscription.scheduledPlanId, "starter");
  assert.equal(deps.charges.length, chargesBefore);
  assert.deepEqual(deps.store.invoicesFor(id), []);
});

test("a scheduled downgrade takes effect at the renewal", async () => {
  const id = activeSubscription("pro");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));
  await changePlan(id, "starter");

  await renewDue(deps, APR_15);

  const renewed = deps.store.getSubscription(id);
  assert.equal(renewed?.planId, "starter");
  assert.equal(renewed?.scheduledPlanId, null);
  const [invoice] = deps.store.invoicesFor(id);
  assert.equal(invoice?.subtotalCents, 1_000);
  assert.equal(invoice?.billingReason, "period");
});

test("an upgrade replaces a scheduled downgrade", async () => {
  const id = activeSubscription("pro");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));
  await changePlan(id, "starter");

  const { body } = await changePlan(id, "business");

  assert.equal(body.subscription.planId, "business");
  assert.equal(body.subscription.scheduledPlanId, null);
});

test("a failed upgrade charge leaves the new plan past due with its invoice open", async () => {
  const id = activeSubscription("starter");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));
  deps.declining.value = true;

  const { status, body } = await changePlan(id, "pro");
  deps.declining.value = false;

  assert.equal(status, 200);
  assert.equal(body.subscription.planId, "pro");
  assert.equal(body.subscription.status, "past_due");
  assert.equal(body.invoice.status, "open");
  assert.equal(deps.store.getSubscription(id)?.status, "past_due");
});

test("plans that can't be moved to answer 409 or 422", async () => {
  const id = activeSubscription("pro");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));

  assert.deepEqual(await changePlan(id, "pro"), { status: 409, body: { kind: "same_plan", planId: "pro" } });
  assert.deepEqual(await changePlan(id, "pro-yearly"), {
    status: 422,
    body: { kind: "interval_mismatch", from: "month", to: "year" },
  });
  assert.deepEqual(await changePlan(id, "legacy-basic"), {
    status: 422,
    body: { kind: "unknown_plan", planId: "legacy-basic" },
  });
  assert.equal(deps.store.getSubscription(id)?.planId, "pro");
});

test("a canceled subscription can't change plan", async () => {
  const id = activeSubscription("starter");
  const subscription = deps.store.getSubscription(id)!;
  deps.store.saveSubscription({ ...subscription, status: "canceled", canceledAt: MAR_15 });

  const { status, body } = await changePlan(id, "pro");

  assert.equal(status, 409);
  assert.deepEqual(body, { kind: "not_changeable", status: "canceled" });
});

test("only the subscription's customer and admins can change its plan", async () => {
  const id = activeSubscription("starter");
  deps.clock.set(new Date("2026-03-30T00:00:00.000Z"));

  assert.equal((await changePlan(id, "pro", "bob")).status, 404);
  assert.equal(deps.store.getSubscription(id)?.planId, "starter");
  assert.equal((await changePlan(id, "pro", "ada")).status, 200);
});

test("a plan change body needs a planId and nothing else", async () => {
  const id = activeSubscription("starter");
  const path = `/subscriptions/${id}/plan`;

  assert.equal((await request("POST", path, { token: "alice", body: {} })).status, 400);
  assert.equal((await request("POST", path, { token: "alice", body: { planId: "pro", prorate: false } })).status, 400);
  assert.equal(deps.store.getSubscription(id)?.planId, "starter");
});
