import assert from "node:assert/strict";
import { test } from "node:test";
import { lineTotal, total } from "../src/invoice.js";

const lines = [
  { sku: "A-1", quantity: 2, unitCents: 250 },
  { sku: "B-7", quantity: 1, unitCents: 1000 },
];

test("a line total is quantity times unit price", () => {
  assert.equal(lineTotal(lines[0]), 500);
});

test("the total sums the lines", () => {
  assert.equal(total(lines), 1500);
  assert.equal(total([]), 0);
});
