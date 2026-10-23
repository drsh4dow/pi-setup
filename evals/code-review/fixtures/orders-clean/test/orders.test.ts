import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelOrder, markPaid, markShipped, placeOrder, priceLines } from "../src/orders.ts";
import { CATALOG, NOW } from "./helpers.ts";

const mugs = [{ sku: "MUG-01", quantity: 3, unitPriceCents: 1200 }];

test("an order's total is its subtotal plus 8.25% tax, rounded to the cent", () => {
  const order = placeOrder({ id: "o1", customerId: "c1", lines: mugs, at: NOW });
  assert.equal(order.subtotalCents, 3600);
  assert.equal(order.taxCents, 297);
  assert.equal(order.totalCents, 3897);
  assert.equal(order.status, "placed");
});

test("pricing takes unit prices from the catalog and names an unknown SKU", () => {
  assert.deepEqual(priceLines([{ sku: "TEE-M", quantity: 1 }], CATALOG), {
    ok: true,
    value: [{ sku: "TEE-M", quantity: 1, unitPriceCents: 2500 }],
  });
  assert.deepEqual(priceLines([{ sku: "TEE-M", quantity: 1 }, { sku: "HAT", quantity: 1 }], CATALOG), {
    ok: false,
    error: { kind: "unknown_sku", sku: "HAT" },
  });
});

test("an order moves placed, paid, shipped", () => {
  const placed = placeOrder({ id: "o1", customerId: "c1", lines: mugs, at: NOW });
  const paid = markPaid(placed, { paymentRef: "pi_1", at: NOW });
  assert.ok(paid.ok);
  assert.equal(paid.value.status, "paid");
  const shipped = markShipped(paid.value, { at: NOW });
  assert.ok(shipped.ok);
  assert.equal(shipped.value.status, "shipped");
  assert.equal(shipped.value.shippedAt, NOW.toISOString());
});

test("out-of-order transitions are rejected with the current status", () => {
  const placed = placeOrder({ id: "o1", customerId: "c1", lines: mugs, at: NOW });
  assert.deepEqual(markShipped(placed, { at: NOW }), {
    ok: false,
    error: { kind: "invalid_transition", from: "placed", to: "shipped" },
  });
  const paid = markPaid(placed, { paymentRef: "pi_1", at: NOW });
  assert.ok(paid.ok);
  assert.deepEqual(cancelOrder(paid.value, { at: NOW }), {
    ok: false,
    error: { kind: "invalid_transition", from: "paid", to: "cancelled" },
  });
});
