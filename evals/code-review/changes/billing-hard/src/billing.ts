import { invoiceEvent, subscriptionEvent, type SubscriptionEventType, type WebhookEvent } from "./events.ts";
import { draftInvoice, finalizeInvoice, formatInvoiceNumber, markInvoicePaid, periodLine, type Invoice } from "./invoices.ts";
import type { PaymentProvider } from "./payments.ts";
import type { Plan, PlanCatalog } from "./plans.ts";
import type { BillingStore } from "./store.ts";
import { cancelSubscription, markPastDue, renew, type Subscription } from "./subscriptions.ts";

export type Clock = { now(): Date };

/** Structured logging: an event name and the ids needed to find what it is about. */
export type Log = (event: string, fields: Record<string, unknown>) => void;

export type BillingDeps = {
  store: BillingStore;
  plans: PlanCatalog;
  payments: PaymentProvider;
  webhooks: { publish(event: WebhookEvent): Promise<void> };
  clock: Clock;
  newId(): string;
  taxRateBasisPoints: number;
  log: Log;
};

/** Sends a subscription event describing `subscription` as it is now. */
export async function publishSubscription(
  deps: BillingDeps,
  type: SubscriptionEventType,
  subscription: Subscription,
  at: Date,
): Promise<void> {
  await deps.webhooks.publish(subscriptionEvent({ id: deps.newId(), type, subscription, at }));
}

/** Returns a draft invoice billing `plan` for the subscription's current period. */
export function periodInvoice(deps: BillingDeps, subscription: Subscription, plan: Plan, at: Date): Invoice {
  return draftInvoice({
    id: deps.newId(),
    customerId: subscription.customerId,
    subscriptionId: subscription.id,
    lines: [periodLine(plan, subscription.currentPeriodStart, subscription.currentPeriodEnd)],
    taxRateBasisPoints: deps.taxRateBasisPoints,
    billingReason: "period",
    at,
  });
}

/**
 * Finalizes `draft` under the next invoice number, saves it, sends `invoice.finalized`, and
 * collects it. Resolves to the invoice as it ends up: `paid`, or `open` when the charge failed.
 */
export async function issueInvoice(deps: BillingDeps, draft: Invoice, at: Date): Promise<Invoice> {
  const finalized = finalizeInvoice(draft, { number: formatInvoiceNumber(deps.store.takeInvoiceNumber()), at });
  if (!finalized.ok) throw new Error(`issueInvoice: invoice ${draft.id} is ${draft.status}, not a draft`);

  deps.store.saveInvoice(finalized.value);
  await deps.webhooks.publish(invoiceEvent({ id: deps.newId(), type: "invoice.finalized", invoice: finalized.value, at }));
  return collectInvoice(deps, finalized.value, at);
}

/**
 * Charges an open invoice for its total, or marks it paid without a charge when the total is
 * zero. Resolves to the paid invoice, or to the invoice still open after sending
 * `invoice.payment_failed` when the charge failed.
 */
export async function collectInvoice(deps: BillingDeps, invoice: Invoice, at: Date): Promise<Invoice> {
  if (invoice.totalCents > 0) {
    const charge = await deps.payments.charge({
      customerId: invoice.customerId,
      amountCents: invoice.totalCents,
      idempotencyKey: `${invoice.id}@${at.toISOString()}`,
    });
    if (!charge.ok) {
      deps.log("invoice_charge_failed", { invoiceId: invoice.id, reason: charge.error.kind });
      await deps.webhooks.publish(invoiceEvent({ id: deps.newId(), type: "invoice.payment_failed", invoice, at }));
      return invoice;
    }
  }

  const paid = markInvoicePaid(invoice, { at });
  if (!paid.ok) throw new Error(`collectInvoice: invoice ${invoice.id} is ${invoice.status}, not open`);
  deps.store.saveInvoice(paid.value);
  await deps.webhooks.publish(invoiceEvent({ id: deps.newId(), type: "invoice.paid", invoice: paid.value, at }));
  return paid.value;
}

/**
 * Puts a subscription `past_due` after a failed charge and sends `subscription.updated`.
 * Reads the subscription from the store, because issuing the invoice awaited the provider
 * and the stored subscription may have changed meanwhile. Resolves to the stored result.
 */
export async function fallBehind(deps: BillingDeps, subscriptionId: string, at: Date): Promise<Subscription> {
  const subscription = deps.store.getSubscription(subscriptionId);
  if (!subscription) throw new Error(`fallBehind: no subscription ${subscriptionId}`);

  const pastDue = markPastDue(subscription, at);
  if (!pastDue.ok) return subscription;
  deps.store.saveSubscription(pastDue.value);
  await publishSubscription(deps, "subscription.updated", pastDue.value, at);
  return pastDue.value;
}

/**
 * Renews every trialing or active subscription whose period ended by `at`: cancels the ones
 * set to cancel at period end, and moves the rest into their next period, on the scheduled
 * plan when a downgrade is waiting, and invoices it.
 */
export async function renewDue(deps: BillingDeps, at: Date): Promise<void> {
  for (const subscription of deps.store.subscriptions()) {
    if (subscription.currentPeriodEnd > at) continue;
    if (subscription.status !== "trialing" && subscription.status !== "active") continue;
    await renewOne(deps, subscription, at);
  }
}

async function renewOne(deps: BillingDeps, subscription: Subscription, at: Date): Promise<void> {
  if (subscription.cancelAtPeriodEnd) {
    const canceled = cancelSubscription(subscription, at);
    if (!canceled.ok) throw new Error(`renewDue: cannot cancel subscription ${subscription.id}`);
    deps.store.saveSubscription(canceled.value);
    await publishSubscription(deps, "subscription.canceled", canceled.value, at);
    return;
  }

  const planId = subscription.scheduledPlanId ?? subscription.planId;
  const plan = deps.plans.get(planId);
  if (!plan) throw new Error(`renewDue: subscription ${subscription.id} renews on unknown plan ${planId}`);
  const renewed = renew(subscription, plan);
  if (!renewed.ok) throw new Error(`renewDue: cannot renew subscription ${subscription.id}`);

  deps.store.saveSubscription(renewed.value);
  await publishSubscription(deps, "subscription.updated", renewed.value, at);
  const invoice = await issueInvoice(deps, periodInvoice(deps, renewed.value, plan, at), at);
  if (invoice.status !== "paid") await fallBehind(deps, subscription.id, at);
}
