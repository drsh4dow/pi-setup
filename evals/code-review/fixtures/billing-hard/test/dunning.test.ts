import assert from "node:assert/strict";
import { test } from "node:test";
import { renewDue } from "../src/billing.ts";
import { runDunning } from "../src/dunning.ts";
import { addDays } from "../src/periods.ts";
import { startSubscription } from "../src/subscriptions.ts";
import { eventTypes, makeDeps, NOW, type TestDeps } from "./helpers.ts";

const TRIAL_END = new Date("2026-03-15T00:00:00.000Z");

/** Returns deps holding one pro subscription that fell behind when its trial ended. */
async function pastDue(): Promise<TestDeps> {
  const deps = makeDeps();
  deps.store.saveSubscription(startSubscription({ id: "sub_1", customerId: "cus_alice", plan: deps.plans.get("pro")!, at: NOW }));
  deps.declining.value = true;
  await renewDue(deps, TRIAL_END);
  assert.equal(deps.store.getSubscription("sub_1")!.status, "past_due");
  return deps;
}

test("a successful retry pays the invoice and makes the subscription active again", async () => {
  const deps = await pastDue();
  deps.declining.value = false;

  await runDunning(deps, addDays(TRIAL_END, 3));

  const subscription = deps.store.getSubscription("sub_1")!;
  assert.equal(subscription.status, "active");
  assert.equal(subscription.pastDueSince, null);
  assert.deepEqual(deps.store.invoicesFor("sub_1").map((invoice) => invoice.status), ["paid"]);
});

test("a subscription still behind after 13 days stays past due", async () => {
  const deps = await pastDue();
  await runDunning(deps, addDays(TRIAL_END, 13));
  assert.equal(deps.store.getSubscription("sub_1")!.status, "past_due");
});

test("a subscription still behind after 14 days is canceled and its invoice voided", async () => {
  const deps = await pastDue();

  await runDunning(deps, addDays(TRIAL_END, 14));

  assert.equal(deps.store.getSubscription("sub_1")!.status, "canceled");
  assert.deepEqual(deps.store.invoicesFor("sub_1").map((invoice) => invoice.status), ["void"]);
  assert.equal(eventTypes(deps).at(-1), "subscription.canceled");
});
