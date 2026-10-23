import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cents } from "../src/money.ts";
import { cancelOrder, markPaid, markShipped, placeOrder, type Order } from "../src/orders.ts";
import { refundableCents, refundOrder } from "../src/refunds.ts";
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

function refunded(order: Order, amountCents: Cents, id = "r1"): Order {
  const result = refundOrder(order, { id, amountCents, reason: "damaged mug", at: NOW });
  assert.ok(result.ok);
  return result.value;
}

test("a partial refund is recorded with the clock's time and keeps the order paid", () => {
  const order = refunded(paidOrder(), 1000);
  assert.equal(order.status, "paid");
  assert.deepEqual(order.refunds, [{ id: "r1", amountCents: 1000, reason: "damaged mug", createdAt: NOW.toISOString() }]);
  assert.equal(refundableCents(order), 1598);
});

test("refunds that reach the total mark the order refunded", () => {
  const order = refunded(refunded(paidOrder(), 1000, "r1"), 1598, "r2");
  assert.equal(order.status, "refunded");
  assert.equal(refundableCents(order), 0);
});

test("a shipped order stays shipped after a partial refund, and is refunded in full", () => {
  const shipped = markShipped(paidOrder(), { at: NOW });
  assert.ok(shipped.ok);
  const partly = refunded(shipped.value, 1000);
  assert.equal(partly.status, "shipped");
  assert.equal(refunded(partly, 1598, "r2").status, "refunded");
});

test("partial refunds together cannot exceed the total", () => {
  const order = refunded(paidOrder(), 2000);
  assert.deepEqual(refundOrder(order, { id: "r2", amountCents: 599, reason: "returned", at: NOW }), {
    ok: false,
    error: { kind: "exceeds_balance", remainingCents: 598 },
  });
});

test("only paid and shipped orders can be refunded", () => {
  const input = { id: "r2", amountCents: 1, reason: "goodwill", at: NOW };
  assert.deepEqual(refundOrder(placedOrder(), input), {
    ok: false,
    error: { kind: "not_refundable", status: "placed" },
  });
  assert.deepEqual(refundOrder(refunded(paidOrder(), 2598), input), {
    ok: false,
    error: { kind: "not_refundable", status: "refunded" },
  });
  const cancelled = cancelOrder(placedOrder(), { at: NOW });
  assert.ok(cancelled.ok);
  assert.deepEqual(refundOrder(cancelled.value, input), {
    ok: false,
    error: { kind: "not_refundable", status: "cancelled" },
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

function refund(id: string, token: string, body: unknown) {
  return request("POST", `/orders/${id}/refunds`, { token, body });
}

test("staff refund an order and its customer lists the refunds newest first", async () => {
  const id = await paidOrderId();
  const first = await refund(id, "sam", { amountCents: 500, reason: "late delivery" });
  assert.equal(first.status, 201);
  assert.equal(first.body.status, "paid");
  assert.equal(first.body.refunds.length, 1);
  const [record] = first.body.refunds;
  assert.match(record.id, /^id_\d+$/);
  assert.equal(record.createdAt, NOW.toISOString());
  assert.equal((await refund(id, "sam", { amountCents: 799, reason: "returned" })).body.status, "refunded");

  const listed = await request("GET", `/orders/${id}/refunds`, { token: "alice" });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.map((r: { amountCents: Cents; reason: string }) => [r.amountCents, r.reason]),
    [[799, "returned"], [500, "late delivery"]],
  );
});

test("customers can't refund, even their own order", async () => {
  const id = await paidOrderId();
  assert.deepEqual(await refund(id, "alice", { amountCents: 1299, reason: "refund me" }), {
    status: 403,
    body: { kind: "forbidden" },
  });
  const order = await request("GET", `/orders/${id}`, { token: "alice" });
  assert.deepEqual(order.body.refunds, []);
});

test("refund failures answer 400, 409, and 422", async () => {
  const id = await paidOrderId();
  assert.equal((await refund(id, "sam", { amountCents: 500, reason: " " })).status, 400);
  for (const amountCents of [0, -100, 0.5, "100", undefined]) {
    assert.equal((await refund(id, "sam", { amountCents, reason: "returned" })).status, 400);
  }
  assert.equal((await refund(id, "sam", { amountCents: 100, reason: 42 })).status, 400);
  assert.deepEqual(await refund(id, "sam", { amountCents: 1300, reason: "returned" }), {
    status: 422,
    body: { kind: "exceeds_balance", remainingCents: 1299 },
  });

  const placed = await request("POST", "/orders", { token: "alice", body: { lines: [{ sku: "MUG-01", quantity: 1 }] } });
  assert.deepEqual(await refund(placed.body.id, "sam", { amountCents: 100, reason: "returned" }), {
    status: 409,
    body: { kind: "not_refundable", status: "placed" },
  });
});

test("staff list any order's refunds", async () => {
  const id = await paidOrderId();
  await refund(id, "sam", { amountCents: 500, reason: "late delivery" });
  const listed = await request("GET", `/orders/${id}/refunds`, { token: "sam" });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.map((r: { amountCents: Cents }) => r.amountCents),
    [500],
  );
});

test("another customer can't see an order's refunds", async () => {
  const id = await paidOrderId();
  assert.equal((await request("GET", `/orders/${id}/refunds`, { token: "bob" })).status, 404);
});
