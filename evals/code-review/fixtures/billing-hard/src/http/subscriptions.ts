import { fallBehind, issueInvoice, periodInvoice, publishSubscription } from "../billing.ts";
import { parseNewSubscription, parseSubscriptionUpdate } from "../input.ts";
import { applyUpdate, startSubscription } from "../subscriptions.ts";
import { findSubscription, forbidden, type Context, type Reply } from "./replies.ts";

export function listPlans({ deps }: Context): Reply {
  return { status: 200, body: deps.plans.listed() };
}

export async function createSubscription({ deps, caller, body }: Context): Promise<Reply> {
  if (caller.kind !== "customer") return forbidden();
  const input = parseNewSubscription(body);
  if (!input.ok) return { status: 400, body: input.error };
  const plan = deps.plans.forSignup(input.value.planId);
  if (!plan) return { status: 422, body: { kind: "unknown_plan", planId: input.value.planId } };

  const at = deps.clock.now();
  const subscription = startSubscription({ id: deps.newId(), customerId: caller.customerId, plan, at });
  deps.store.saveSubscription(subscription);
  await publishSubscription(deps, "subscription.created", subscription, at);
  if (subscription.status === "trialing") return { status: 201, body: { subscription, invoice: null } };

  const invoice = await issueInvoice(deps, periodInvoice(deps, subscription, plan, at), at);
  if (invoice.status === "paid") return { status: 201, body: { subscription, invoice } };
  return { status: 201, body: { subscription: await fallBehind(deps, subscription.id, at), invoice } };
}

export function getSubscription({ deps, caller, id }: Context): Reply {
  const found = findSubscription(deps, caller, id);
  if (!found.ok) return found.error;
  return { status: 200, body: found.value };
}

export async function updateSubscription({ deps, caller, id, body }: Context): Promise<Reply> {
  const found = findSubscription(deps, caller, id);
  if (!found.ok) return found.error;
  const update = parseSubscriptionUpdate(body);
  if (!update.ok) return { status: 400, body: update.error };
  if (found.value.status === "canceled") return { status: 409, body: { kind: "subscription_canceled" } };

  const updated = applyUpdate(found.value, update.value);
  deps.store.saveSubscription(updated);
  await publishSubscription(deps, "subscription.updated", updated, deps.clock.now());
  return { status: 200, body: updated };
}

export function listInvoices({ deps, caller, id }: Context): Reply {
  const found = findSubscription(deps, caller, id);
  if (!found.ok) return found.error;
  return { status: 200, body: deps.store.invoicesFor(found.value.id).toReversed() };
}
