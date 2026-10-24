import assert from "node:assert/strict";
import { test } from "node:test";
import { totalCents } from "../src/checkout.js";

test("a gift costs its price", () => {
  assert.equal(totalCents({ priceCents: 2500 }), 2500);
});
