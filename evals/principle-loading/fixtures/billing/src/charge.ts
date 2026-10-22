import { invoices, users } from "./model.ts";

export type Gateway = { charge(paymentMethodId: string, amountCents: number): Promise<boolean> };

export async function chargeInvoice(gateway: Gateway, invoiceId: string): Promise<void> {
  const invoice = invoices.get(invoiceId);
  if (!invoice) throw new Error(`unknown invoice ${invoiceId}`);
  const user = users.get(invoice.userId);
  if (!user) throw new Error(`unknown user ${invoice.userId}`);

  invoice.attempts += 1;
  invoice.status = (await gateway.charge(user.paymentMethodId, invoice.amountCents)) ? "paid" : "failed";
}
