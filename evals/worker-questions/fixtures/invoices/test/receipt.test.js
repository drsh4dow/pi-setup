import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReceipt } from "../src/receipt.js";

test("a receipt lists each line and the total", () => {
  const receipt = renderReceipt({
    number: "INV-9",
    currency: "GBP",
    lines: [{ sku: "A-1", quantity: 2, unitCents: 250 }],
  });

  assert.equal(receipt, "Invoice INV-9\nA-1  x2  5.00 GBP\nTotal  5.00 GBP");
});
