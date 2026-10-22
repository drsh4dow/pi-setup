import assert from "node:assert/strict";
import { test } from "node:test";
import { chargeInvoice } from "../src/charge.ts";
import { createInvoice, invoicesForUser } from "../src/invoices.ts";

test("charging an invoice uses the user's payment method", async () => {
  const charged: string[] = [];
  const invoice = createInvoice("u_1", 1500, "2026-10");
  await chargeInvoice({ charge: async (pm) => { charged.push(pm); return true; } }, invoice.id);
  assert.deepEqual(charged, ["pm_1"]);
  assert.equal(invoicesForUser("u_1")[0].status, "paid");
});
