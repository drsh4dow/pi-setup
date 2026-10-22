import { chargeInvoice, type Gateway } from "./charge.ts";
import { sendPaymentFailedEmail, type Mailer } from "./emails.ts";
import { invoices } from "./model.ts";

const MAX_ATTEMPTS = 3;

export async function retryFailedInvoices(gateway: Gateway, mailer: Mailer): Promise<void> {
  for (const invoice of invoices.values()) {
    if (invoice.status !== "failed" || invoice.attempts >= MAX_ATTEMPTS) continue;
    await chargeInvoice(gateway, invoice.id);
    if (invoice.status === "failed") sendPaymentFailedEmail(mailer, invoice);
  }
}
