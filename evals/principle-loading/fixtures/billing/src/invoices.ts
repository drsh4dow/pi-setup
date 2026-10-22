import { invoices, users, type Invoice } from "./model.ts";

let next = 1;

export function createInvoice(userId: string, amountCents: number, period: string): Invoice {
  if (!users.has(userId)) throw new Error(`unknown user ${userId}`);
  const invoice: Invoice = { id: `inv_${next++}`, userId, amountCents, period, status: "open", attempts: 0 };
  invoices.set(invoice.id, invoice);
  return invoice;
}

export function invoicesForUser(userId: string): Invoice[] {
  return [...invoices.values()].filter((invoice) => invoice.userId === userId);
}
