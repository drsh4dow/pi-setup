import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBasisPoints, formatCents, scaleCents } from "../src/money.ts";

test("scaleCents rounds to the nearest cent, halves away from zero", () => {
  assert.equal(scaleCents(1_000, 1, 3), 333);
  assert.equal(scaleCents(1_000, 2, 3), 667);
  assert.equal(scaleCents(5, 1, 2), 3);
  assert.equal(scaleCents(-5, 1, 2), -3);
});

test("scaleCents rejects a denominator that isn't positive", () => {
  assert.throws(() => scaleCents(1_000, 1, 0), RangeError);
});

test("applyBasisPoints takes hundredths of a percent", () => {
  assert.equal(applyBasisPoints(3_100, 825), 256);
  assert.equal(applyBasisPoints(1_000, 1_000), 100);
});

test("formatCents writes dollars with two decimals", () => {
  assert.equal(formatCents(1_250), "$12.50");
  assert.equal(formatCents(-300), "-$3.00");
  assert.equal(formatCents(5), "$0.05");
});
