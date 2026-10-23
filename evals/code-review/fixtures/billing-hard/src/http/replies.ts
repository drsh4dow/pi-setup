import { canAccess, type Caller } from "../auth.ts";
import type { BillingDeps } from "../billing.ts";
import { err, ok, type Result } from "../result.ts";
import type { Subscription } from "../subscriptions.ts";

export type HttpDeps = BillingDeps & { tokens: ReadonlyMap<string, Caller> };

export type Reply = { status: number; body: unknown };

export type Context = { deps: HttpDeps; caller: Caller; id: string; body: unknown };

/** Returns the 403 reply for a caller who may not use an endpoint at all. */
export function forbidden(): Reply {
  return { status: 403, body: { kind: "forbidden" } };
}

/**
 * Returns the subscription `id` if `caller` may access it. Unknown subscriptions and other
 * customers' subscriptions both answer 404, so ids can't be probed.
 */
export function findSubscription(deps: HttpDeps, caller: Caller, id: string): Result<Subscription, Reply> {
  const subscription = deps.store.getSubscription(id);
  if (!subscription || !canAccess(caller, subscription)) {
    return err({ status: 404, body: { kind: "subscription_not_found" } });
  }
  return ok(subscription);
}
