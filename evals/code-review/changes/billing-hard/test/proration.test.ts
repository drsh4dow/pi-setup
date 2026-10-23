import assert from "node:assert/strict";
import { test } from "node:test";
import { scaleCents } from "../src/money.ts";
import { DEMO_PLANS, PlanCatalog, type Plan } from "../src/plans.ts";
import { openProrationInvoice, prorationLines } from "../src/proration.ts";
import { renew, startSubscription, type Subscription } from "../src/subscriptions.ts";

const plans = new PlanCatalog(DEMO_PLANS);
const starter = plan("starter");
const pro = plan("pro");

function plan(id: string): Plan {
  const found = plans.get(id);
  assert.ok(found);
  return found;
}

/** A starter subscription whose trial ended on Mar 1: its first paid period is March, 31 days. */
function marchSubscription(): Subscription {
  const trial = startSubscription({ id: "sub_1", customerId: "cus_alice", plan: starter, at: new Date("2026-02-15T00:00:00.000Z") });
  const renewed = renew(trial, starter);
  assert.ok(renewed.ok);
  assert.equal(renewed.value.currentPeriodStart.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(renewed.value.currentPeriodEnd.toISOString(), "2026-04-01T00:00:00.000Z");
  return renewed.value;
}

test("an upgrade credits the unused days on the old plan, then charges them on the new one", () => {
  const at = new Date("2026-03-16T00:00:00.000Z");
  const lines = prorationLines({ subscription: marchSubscription(), from: starter, to: pro, at });

  assert.deepEqual(
    lines.map((line) => [line.kind, line.amountCents, line.description]),
    [
      ["proration_credit", -516, "Unused time on Starter (16 of 31 days)"],
      ["proration_charge", 1_600, "Remaining time on Pro (16 of 31 days)"],
    ],
  );
});

test("proration lines cover the change up to the period end", () => {
  const at = new Date("2026-03-16T00:00:00.000Z");
  for (const line of prorationLines({ subscription: marchSubscription(), from: starter, to: pro, at })) {
    assert.equal(line.periodStart.toISOString(), at.toISOString());
    assert.equal(line.periodEnd.toISOString(), "2026-04-01T00:00:00.000Z");
  }
});

for (const { at, remainingDays } of [
  { at: "2026-03-01T00:00:00.000Z", remainingDays: 31 },
  { at: "2026-03-21T00:00:00.000Z", remainingDays: 11 },
  { at: "2026-03-31T00:00:00.000Z", remainingDays: 1 },
]) {
  test(`a change at ${at} prorates ${remainingDays} days, the day of the change included`, () => {
    const [credit, charge] = prorationLines({ subscription: marchSubscription(), from: starter, to: pro, at: new Date(at) });
    assert.equal(credit?.amountCents, -scaleCents(starter.priceCents, remainingDays, 31));
    assert.equal(charge?.amountCents, scaleCents(pro.priceCents, remainingDays, 31));
    assert.ok(charge?.description.endsWith(`(${remainingDays} of 31 days)`));
  });
}

test("the proration invoice nets the lines and taxes the difference", () => {
  const at = new Date("2026-03-16T00:00:00.000Z");
  const invoice = openProrationInvoice(
    { newId: () => "inv_1", taxRateBasisPoints: 1_000 },
    { subscription: marchSubscription(), from: starter, to: pro, at },
  );

  assert.equal(invoice.status, "draft");
  assert.equal(invoice.number, null);
  assert.equal(invoice.billingReason, "plan_change");
  assert.equal(invoice.subtotalCents, 1_084);
  assert.equal(invoice.taxCents, 108);
  assert.equal(invoice.totalCents, 1_192);
});
