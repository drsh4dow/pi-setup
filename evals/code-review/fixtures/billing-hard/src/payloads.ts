import type { Invoice } from "./invoices.ts";
import type { Subscription } from "./subscriptions.ts";

/** Returns the `data` of a subscription event. */
export function subscriptionPayload(subscription: Subscription): Record<string, unknown> {
  return {
    id: subscription.id,
    customerId: subscription.customerId,
    planId: subscription.planId,
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart.toISOString(),
    currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt?.toISOString() ?? null,
  };
}

/** Returns the `data` of an invoice event. */
export function invoicePayload(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
    number: invoice.number,
    customerId: invoice.customerId,
    subscriptionId: invoice.subscriptionId,
    status: invoice.status,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      amountCents: line.amountCents,
      periodStart: line.periodStart.toISOString(),
      periodEnd: line.periodEnd.toISOString(),
    })),
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    totalCents: invoice.totalCents,
  };
}
