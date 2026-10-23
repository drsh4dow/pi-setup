import { fallBehind, issueInvoice, publishSubscription, type BillingDeps } from "./billing.ts";
import type { Invoice } from "./invoices.ts";
import type { Interval } from "./periods.ts";
import type { PlanId } from "./plans.ts";
import { openProrationInvoice } from "./proration.ts";
import { err, ok, type Result } from "./result.ts";
import { scheduleDowngrade, switchPlan, type Subscription, type SubscriptionStatus } from "./subscriptions.ts";

export type PlanChangeError =
  | { kind: "not_changeable"; status: SubscriptionStatus }
  | { kind: "unknown_plan"; planId: PlanId }
  | { kind: "same_plan"; planId: PlanId }
  | { kind: "interval_mismatch"; from: Interval; to: Interval };

export type PlanChange =
  | { kind: "upgrade"; subscription: Subscription; invoice: Invoice }
  | { kind: "downgrade"; subscription: Subscription };

const CHANGEABLE: ReadonlySet<SubscriptionStatus> = new Set(["trialing", "active"]);

/**
 * Moves `subscription` to the plan `planId` at `at`; see "Plan changes" in the README. An
 * upgrade switches plan now and issues a proration invoice for the rest of the period; a
 * downgrade is scheduled for the next renewal. Fails, changing nothing, when the
 * subscription's status or the target plan rules the move out.
 */
export async function changePlan(
  deps: BillingDeps,
  input: { subscription: Subscription; planId: PlanId; at: Date },
): Promise<Result<PlanChange, PlanChangeError>> {
  const { subscription, planId, at } = input;
  if (!CHANGEABLE.has(subscription.status)) return err({ kind: "not_changeable", status: subscription.status });

  const current = deps.plans.get(subscription.planId);
  if (!current) throw new Error(`changePlan: subscription ${subscription.id} is on unknown plan ${subscription.planId}`);
  const next = deps.plans.forSignup(planId);
  if (!next) return err({ kind: "unknown_plan", planId });
  if (next.id === current.id) return err({ kind: "same_plan", planId });
  if (next.interval !== current.interval) {
    return err({ kind: "interval_mismatch", from: current.interval, to: next.interval });
  }

  if (next.priceCents <= current.priceCents) {
    const scheduled = scheduleDowngrade(subscription, next);
    deps.store.saveSubscription(scheduled);
    await publishSubscription(deps, "subscription.updated", scheduled, at);
    return ok({ kind: "downgrade", subscription: scheduled });
  }

  const switched = switchPlan(subscription, next);
  deps.store.saveSubscription(switched);
  await publishSubscription(deps, "subscription.updated", switched, at);

  const invoice = await issueInvoice(deps, openProrationInvoice(deps, { subscription, from: current, to: next, at }), at);
  if (invoice.status === "paid") return ok({ kind: "upgrade", subscription: switched, invoice });
  return ok({ kind: "upgrade", subscription: await fallBehind(deps, subscription.id, at), invoice });
}
