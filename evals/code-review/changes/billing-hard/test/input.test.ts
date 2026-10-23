import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNewSubscription, parsePlanChange, parseSubscriptionUpdate } from "../src/input.ts";

test("subscription bodies reject fields they don't know", () => {
  for (const parse of [parseNewSubscription, parsePlanChange, parseSubscriptionUpdate]) {
    assert.deepEqual(parse({ planId: "pro", coupon: "FREE" }), {
      ok: false,
      error: { kind: "invalid_input", message: "unknown field coupon" },
    });
  }
});

test("a new subscription and a plan change both need a plan", () => {
  for (const parse of [parseNewSubscription, parsePlanChange]) {
    assert.deepEqual(parse({}), { ok: false, error: { kind: "invalid_input", message: "planId is required" } });
    assert.equal(parse({ planId: " " }).ok, false);
    assert.deepEqual(parse({ planId: "pro" }), { ok: true, value: { planId: "pro" } });
  }
});

test("an update takes cancelAtPeriodEnd as a boolean and nothing else as it", () => {
  assert.deepEqual(parseSubscriptionUpdate({ cancelAtPeriodEnd: true }), { ok: true, value: { cancelAtPeriodEnd: true } });
  assert.deepEqual(parseSubscriptionUpdate({}), { ok: true, value: {} });
  assert.equal(parseSubscriptionUpdate({ cancelAtPeriodEnd: "yes" }).ok, false);
  assert.equal(parseSubscriptionUpdate([]).ok, false);
});
