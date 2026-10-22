import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelOrder, createOrder, markPaid, markShipped } from "../src/orders/orders.ts";

test("a paid order can be shipped", () => {
  const order = createOrder("c_1", undefined, [{ sku: "MUG", name: "Mug", unitPriceCents: 1200, quantity: 1 }]);
  markPaid(order.id);
  markShipped(order.id);
  assert.equal(order.isShipped, true);
});

test("a shipped order cannot be cancelled", () => {
  const order = createOrder("c_1", undefined, []);
  markPaid(order.id);
  markShipped(order.id);
  assert.throws(() => cancelOrder(order.id));
});
