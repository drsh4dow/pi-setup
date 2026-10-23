import type { BillingDeps } from "./billing.ts";
import { draftInvoice, type Invoice, type InvoiceLine } from "./invoices.ts";
import type { Cents } from "./money.ts";
import { daysBetween } from "./periods.ts";
import type { Plan } from "./plans.ts";
import type { Subscription } from "./subscriptions.ts";

export type ProrationInput = {
  /** The subscription as it was before the change, still on `from`. */
  subscription: Subscription;
  from: Plan;
  to: Plan;
  at: Date;
};

/**
 * Returns the lines that prorate moving `subscription` from `from` to `to` at `at`: first a
 * credit for the rest of the current period on `from`, then a charge for the same days on
 * `to`. Each is the plan's price scaled by remaining days over the days in the period; the
 * day of the change counts as remaining.
 */
export function prorationLines({ subscription, from, to, at }: ProrationInput): InvoiceLine[] {
  const periodDays = daysBetween(subscription.currentPeriodStart, subscription.currentPeriodEnd);
  const remainingDays = daysBetween(at, subscription.currentPeriodEnd);
  const span = `${remainingDays} of ${periodDays} days`;
  const period = { periodStart: at, periodEnd: subscription.currentPeriodEnd };

  return [
    {
      kind: "proration_credit",
      description: `Unused time on ${from.name} (${span})`,
      amountCents: -shareOfPrice(from.priceCents, remainingDays, periodDays),
      ...period,
    },
    {
      kind: "proration_charge",
      description: `Remaining time on ${to.name} (${span})`,
      amountCents: shareOfPrice(to.priceCents, remainingDays, periodDays),
      ...period,
    },
  ];
}

/** Returns the draft invoice holding the proration lines for the change, billed as a plan change. */
export function openProrationInvoice(deps: Pick<BillingDeps, "newId" | "taxRateBasisPoints">, input: ProrationInput): Invoice {
  return draftInvoice({
    id: deps.newId(),
    customerId: input.subscription.customerId,
    subscriptionId: input.subscription.id,
    lines: prorationLines(input),
    taxRateBasisPoints: deps.taxRateBasisPoints,
    billingReason: "plan_change",
    at: input.at,
  });
}

/** Returns the part of `priceCents` that `days` out of `periodDays` cover, to the nearest cent, halves away from zero. */
function shareOfPrice(priceCents: Cents, days: number, periodDays: number): Cents {
  if (periodDays <= 0) throw new RangeError(`shareOfPrice: a period needs at least one day, got ${periodDays}`);
  const share = (priceCents * days) / periodDays;
  return Math.sign(share) * Math.round(Math.abs(share));
}
