import { addDays, addIntervals } from "./periods.ts";
import type { Plan, PlanId } from "./plans.ts";
import { err, ok, type Result } from "./result.ts";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";

export type Subscription = {
  id: string;
  customerId: string;
  planId: PlanId;
  status: SubscriptionStatus;
  /** The day of the month periods start on, 1 to 31. See addIntervals for short months. */
  anchorDay: number;
  currentPeriodStart: Date;
  /** Exclusive: the first instant of the next period. */
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** When the subscription fell behind on payment; null unless it is `past_due`. */
  pastDueSince: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
};

/** The fields a customer may change directly. */
export type SubscriptionUpdate = { cancelAtPeriodEnd?: boolean };

export type TransitionError = { kind: "invalid_transition"; from: SubscriptionStatus; to: SubscriptionStatus };

/**
 * Returns a new subscription to `plan` starting at `at`. A plan with a trial starts
 * `trialing`, with the trial as its first period; otherwise the subscription starts
 * `active` and its first period is one interval, anchored on the start day.
 */
export function startSubscription(input: { id: string; customerId: string; plan: Plan; at: Date }): Subscription {
  const { id, customerId, plan, at } = input;
  const common = {
    id,
    customerId,
    planId: plan.id,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    canceledAt: null,
    createdAt: at,
    currentPeriodStart: at,
  };

  if (plan.trialDays > 0) {
    const trialEnd = addDays(at, plan.trialDays);
    return { ...common, status: "trialing", anchorDay: trialEnd.getUTCDate(), currentPeriodEnd: trialEnd };
  }

  const anchorDay = at.getUTCDate();
  return { ...common, status: "active", anchorDay, currentPeriodEnd: addIntervals(at, plan.interval, 1, anchorDay) };
}

/** Returns the subscription with the fields of `update` applied. */
export function applyUpdate(subscription: Subscription, update: SubscriptionUpdate): Subscription {
  return { ...subscription, ...update };
}

/**
 * Returns the subscription moved into the period after its current one, billed on `plan`.
 * A trialing subscription becomes active. Fails for a past_due or canceled subscription.
 */
export function renew(subscription: Subscription, plan: Plan): Result<Subscription, TransitionError> {
  if (subscription.status !== "trialing" && subscription.status !== "active") {
    return err(invalidTransition(subscription.status, "active"));
  }
  const start = subscription.currentPeriodEnd;
  return ok({
    ...subscription,
    planId: plan.id,
    status: "active",
    currentPeriodStart: start,
    currentPeriodEnd: addIntervals(start, plan.interval, 1, subscription.anchorDay),
  });
}

/** Returns the subscription `past_due` since `at`. Fails unless it is trialing or active. */
export function markPastDue(subscription: Subscription, at: Date): Result<Subscription, TransitionError> {
  if (subscription.status !== "trialing" && subscription.status !== "active") {
    return err(invalidTransition(subscription.status, "past_due"));
  }
  return ok({ ...subscription, status: "past_due", pastDueSince: at });
}

/** Returns a past_due subscription active again once its invoices are paid. Fails for any other status. */
export function markCurrent(subscription: Subscription): Result<Subscription, TransitionError> {
  if (subscription.status !== "past_due") return err(invalidTransition(subscription.status, "active"));
  return ok({ ...subscription, status: "active", pastDueSince: null });
}

/** Returns the subscription canceled at `at`. Fails when it is already canceled. */
export function cancelSubscription(subscription: Subscription, at: Date): Result<Subscription, TransitionError> {
  if (subscription.status === "canceled") return err(invalidTransition("canceled", "canceled"));
  return ok({ ...subscription, status: "canceled", canceledAt: at, pastDueSince: null });
}

function invalidTransition(from: SubscriptionStatus, to: SubscriptionStatus): TransitionError {
  return { kind: "invalid_transition", from, to };
}
