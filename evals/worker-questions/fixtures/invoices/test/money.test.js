import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAmount } from "../src/money.js";

test("formats cents with two decimals and the currency code", () => {
  assert.equal(formatAmount(1234, "USD"), "12.34 USD");
  assert.equal(formatAmount(5, "GBP"), "0.05 GBP");
});
