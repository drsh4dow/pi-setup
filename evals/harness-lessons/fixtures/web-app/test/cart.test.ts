import assert from "node:assert/strict";
import { test } from "node:test";
import { addItem, subtotalCents } from "../src/cart.ts";

test("adding a sku already in the cart raises its quantity", () => {
  const items = addItem([{ sku: "mug", unitCents: 1200, quantity: 1 }], {
    sku: "mug",
    unitCents: 1200,
    quantity: 2,
  });

  assert.deepEqual(items, [{ sku: "mug", unitCents: 1200, quantity: 3 }]);
});

test("the subtotal sums every line", () => {
  assert.equal(
    subtotalCents([
      { sku: "mug", unitCents: 1200, quantity: 2 },
      { sku: "tea", unitCents: 850, quantity: 1 },
    ]),
    3250,
  );
});
