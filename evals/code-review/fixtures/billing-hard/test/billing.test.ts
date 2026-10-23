import assert from "node:assert/strict";
import { test } from "node:test";
import { issueInvoice, periodInvoice, renewDue } from "../src/billing.ts";
import { startSubscription } from "../src/subscriptions.ts";
import { eventTypes, makeDeps, NOW, type TestDeps } from "./helpers.ts";

function subscribe(deps: TestDeps, planId: string) {
  const plan = deps.plans.get(planId);
  assert.ok(plan);
  const subscription = startSubscription({ id: `sub_${planId}`, customerId: "cus_alice", plan, at: NOW });
  deps.store.saveSubscription(subscription);
  return subscription;
}

test("issuing an invoice numbers it, announces it, and charges its total with tax", async () => {
  const deps = makeDeps();
  const subscription = subscribe(deps, "business");
  const plan = deps.plans.get("business")!;

  const invoice = await issueInvoice(deps, periodInvoice(deps, subscription, plan, NOW), NOW);

  assert.equal(invoice.status, "paid");
  assert.equal(invoice.number, "INV-000001");
  assert.equal(invoice.totalCents, 10_230);
  assert.deepEqual(deps.charges.map((charge) => charge.amountCents), [10_230]);
  assert.deepEqual(eventTypes(deps), ["invoice.finalized", "invoice.paid"]);
});

test("invoice numbers follow each other across subscriptions", async () => {
  const deps = makeDeps();
  const numbers = [];
  for (const planId of ["business", "starter"]) {
    const subscription = subscribe(deps, planId);
    const plan = deps.plans.get(planId)!;
    numbers.push((await issueInvoice(deps, periodInvoice(deps, subscription, plan, NOW), NOW)).number);
  }
  assert.deepEqual(numbers, ["INV-000001", "INV-000002"]);
});

test("a trial renews into its first paid month on the anchor day", async () => {
  const deps = makeDeps();
  subscribe(deps, "pro");
  const trialEnd = new Date("2026-03-15T00:00:00.000Z");

  await renewDue(deps, trialEnd);

  const renewed = deps.store.getSubscription("sub_pro")!;
  assert.equal(renewed.status, "active");
  assert.equal(renewed.currentPeriodStart.toISOString(), trialEnd.toISOString());
  assert.equal(renewed.currentPeriodEnd.toISOString(), "2026-04-15T00:00:00.000Z");
  const [invoice] = deps.store.invoicesFor("sub_pro");
  assert.equal(invoice?.status, "paid");
  assert.equal(invoice?.subtotalCents, 3_100);
});

test("nothing renews before its period ends", async () => {
  const deps = makeDeps();
  subscribe(deps, "pro");
  await renewDue(deps, new Date("2026-03-14T23:59:59.999Z"));
  assert.equal(deps.store.getSubscription("sub_pro")!.status, "trialing");
  assert.deepEqual(deps.store.invoicesFor("sub_pro"), []);
});

test("a failed renewal charge leaves the invoice open and the subscription past due", async () => {
  const deps = makeDeps();
  subscribe(deps, "pro");
  deps.declining.value = true;
  const trialEnd = new Date("2026-03-15T00:00:00.000Z");

  await renewDue(deps, trialEnd);

  const subscription = deps.store.getSubscription("sub_pro")!;
  assert.equal(subscription.status, "past_due");
  assert.equal(subscription.pastDueSince?.toISOString(), trialEnd.toISOString());
  assert.deepEqual(deps.store.invoicesFor("sub_pro").map((invoice) => invoice.status), ["open"]);
  assert.ok(eventTypes(deps).includes("invoice.payment_failed"));
});

test("a subscription set to cancel at period end is canceled instead of renewed", async () => {
  const deps = makeDeps();
  const subscription = subscribe(deps, "pro");
  deps.store.saveSubscription({ ...subscription, cancelAtPeriodEnd: true });

  await renewDue(deps, new Date("2026-03-15T00:00:00.000Z"));

  assert.equal(deps.store.getSubscription("sub_pro")!.status, "canceled");
  assert.deepEqual(deps.store.invoicesFor("sub_pro"), []);
  assert.deepEqual(eventTypes(deps), ["subscription.canceled"]);
});

test("an archived plan keeps renewing at its own price", async () => {
  const deps = makeDeps();
  subscribe(deps, "legacy-basic");
  await renewDue(deps, new Date("2026-04-01T00:00:00.000Z"));
  const [invoice] = deps.store.invoicesFor("sub_legacy-basic");
  assert.equal(invoice?.subtotalCents, 400);
});
