import { collectInvoice, publishSubscription, type BillingDeps } from "./billing.ts";
import { voidInvoice } from "./invoices.ts";
import { daysBetween } from "./periods.ts";
import { cancelSubscription, markCurrent, type Subscription } from "./subscriptions.ts";

/** Whole days a subscription may stay past_due before it is canceled. See docs/dunning.md. */
export const GRACE_DAYS = 14;

/**
 * Retries the open invoices of every past_due subscription. A subscription whose invoices are
 * all paid becomes active again; one still behind GRACE_DAYS after it fell behind is canceled
 * and its open invoices voided.
 */
export async function runDunning(deps: BillingDeps, at: Date): Promise<void> {
  for (const { id, status } of deps.store.subscriptions()) {
    if (status !== "past_due") continue;
    for (const invoice of openInvoices(deps, id)) await collectInvoice(deps, invoice, at);

    const subscription = deps.store.getSubscription(id);
    if (!subscription || subscription.status !== "past_due" || !subscription.pastDueSince) continue;
    if (openInvoices(deps, id).length === 0) {
      await restore(deps, subscription, at);
      continue;
    }
    if (daysBetween(subscription.pastDueSince, at) >= GRACE_DAYS) await cancelForNonPayment(deps, subscription, at);
  }
}

async function restore(deps: BillingDeps, subscription: Subscription, at: Date): Promise<void> {
  const current = markCurrent(subscription);
  if (!current.ok) return;
  deps.store.saveSubscription(current.value);
  await publishSubscription(deps, "subscription.updated", current.value, at);
}

async function cancelForNonPayment(deps: BillingDeps, subscription: Subscription, at: Date): Promise<void> {
  for (const invoice of openInvoices(deps, subscription.id)) {
    const voided = voidInvoice(invoice, { at });
    if (voided.ok) deps.store.saveInvoice(voided.value);
  }
  const canceled = cancelSubscription(subscription, at);
  if (!canceled.ok) return;
  deps.store.saveSubscription(canceled.value);
  deps.log("subscription_canceled_for_non_payment", { subscriptionId: subscription.id });
  await publishSubscription(deps, "subscription.canceled", canceled.value, at);
}

function openInvoices(deps: BillingDeps, subscriptionId: string) {
  return deps.store.invoicesFor(subscriptionId).filter((invoice) => invoice.status === "open");
}
