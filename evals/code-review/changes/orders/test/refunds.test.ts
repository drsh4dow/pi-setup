import assert from "node:assert/strict";
import { test } from "node:test";
import { markPaid, placeOrder, type Order } from "../src/orders.ts";
import { refundOrder } from "../src/refunds.ts";
import { NOW, startApp } from "./helpers.ts";

// Two mugs: 2400 subtotal + 198 tax = 2598 total.
function placedOrder(): Order {
  return placeOrder({ id: "o1", customerId: "c1", lines: [{ sku: "MUG-01", quantity: 2, unitPriceCents: 1200 }], at: NOW });
}

function paidOrder(): Order {
  const paid = markPaid(placedOrder(), { paymentRef: "pi_1", at: NOW });
  assert.ok(paid.ok);
  return paid.value;
}

test("a partial refund is recorded and keeps the order paid", () => {
  const result = refundOrder(paidOrder(), { id: "r1", amountCents: 1000, reason: "damaged mug" });
  assert.ok(result.ok);
  assert.equal(result.value.status, "paid");
  assert.deepEqual(
    result.value.refunds.map(({ id, amountCents, reason }) => ({ id, amountCents, reason })),
    [{ id: "r1", amountCents: 1000, reason: "damaged mug" }],
  );
});

test("refunds that reach the total mark the order refunded", () => {
  const first = refundOrder(paidOrder(), { id: "r1", amountCents: 1000, reason: "damaged mug" });
  assert.ok(first.ok);
  const second = refundOrder(first.value, { id: "r2", amountCents: 1598, reason: "order returned" });
  assert.ok(second.ok);
  assert.equal(second.value.status, "refunded");
  assert.equal(second.value.refundedCents, 2598);
});

test("a refund larger than the order total is rejected", () => {
  assert.deepEqual(refundOrder(paidOrder(), { id: "r1", amountCents: 2599, reason: "returned" }), {
    ok: false,
    error: { kind: "exceeds_balance", remainingCents: 2598 },
  });
});

test("an unpaid order cannot be refunded", () => {
  const result = refundOrder(placedOrder(), { id: "r1", amountCents: 100, reason: "changed mind" });
  if (!result.ok) assert.deepEqual(result.error, { kind: "not_refundable", status: "placed" });
});

test("a fully refunded order cannot be refunded again", () => {
  const full = refundOrder(paidOrder(), { id: "r1", amountCents: 2598, reason: "order returned" });
  assert.ok(full.ok);
  assert.deepEqual(refundOrder(full.value, { id: "r2", amountCents: 1, reason: "goodwill" }), {
    ok: false,
    error: { kind: "not_refundable", status: "refunded" },
  });
});

const { request } = await startApp();

// One mug: 1200 subtotal + 99 tax = 1299 total.
async function paidOrderId(): Promise<string> {
  const placed = await request("POST", "/orders", { token: "alice", body: { lines: [{ sku: "MUG-01", quantity: 1 }] } });
  assert.equal(placed.status, 201);
  const paid = await request("POST", `/orders/${placed.body.id}/payment`, { token: "alice", body: { paymentRef: "pi_7" } });
  assert.equal(paid.status, 200);
  return placed.body.id;
}

test("staff refund an order and its customer can list the refunds", async () => {
  const id = await paidOrderId();
  const refunded = await request("POST", `/orders/${id}/refunds`, {
    token: "sam",
    body: { amountCents: 500, reason: "late delivery" },
  });
  assert.equal(refunded.status, 201);
  assert.equal(refunded.body.refundedCents, 500);
  const listed = await request("GET", `/orders/${id}/refunds`, { token: "alice" });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((refund: { amountCents: number }) => refund.amountCents), [500]);
});

test("refund failures answer 400, 409, and 422", async () => {
  const id = await paidOrderId();
  const blank = await request("POST", `/orders/${id}/refunds`, { token: "sam", body: { amountCents: 500, reason: " " } });
  assert.equal(blank.status, 400);
  const tooMuch = await request("POST", `/orders/${id}/refunds`, { token: "sam", body: { amountCents: 1300, reason: "returned" } });
  assert.deepEqual(tooMuch, { status: 422, body: { kind: "exceeds_balance", remainingCents: 1299 } });

  const placed = await request("POST", "/orders", { token: "alice", body: { lines: [{ sku: "MUG-01", quantity: 1 }] } });
  const unpaid = await request("POST", `/orders/${placed.body.id}/refunds`, { token: "sam", body: { amountCents: 100, reason: "returned" } });
  assert.deepEqual(unpaid, { status: 409, body: { kind: "not_refundable", status: "placed" } });
});

test("another customer can't see an order's refunds", async () => {
  const id = await paidOrderId();
  assert.equal((await request("GET", `/orders/${id}/refunds`, { token: "bob" })).status, 404);
});
