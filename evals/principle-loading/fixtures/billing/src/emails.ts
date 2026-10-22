import { users, type Invoice } from "./model.ts";

export type Mailer = { send(to: string, subject: string, body: string): void };

export function sendInvoiceEmail(mailer: Mailer, invoice: Invoice): void {
  const user = users.get(invoice.userId);
  if (!user) return;
  mailer.send(user.email, `Your invoice for ${invoice.period}`, `Hi ${user.name}, you owe $${(invoice.amountCents / 100).toFixed(2)}.`);
}

export function sendPaymentFailedEmail(mailer: Mailer, invoice: Invoice): void {
  const user = users.get(invoice.userId);
  if (!user) return;
  mailer.send(user.email, "Payment failed", `Hi ${user.name}, we could not charge your card for ${invoice.period}.`);
}
