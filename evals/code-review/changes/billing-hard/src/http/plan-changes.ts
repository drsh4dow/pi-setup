import { parsePlanChange } from "../input.ts";
import { changePlan, type PlanChangeError } from "../plan-changes.ts";
import { findSubscription, type Context, type Reply } from "./replies.ts";

const ERROR_STATUS: Record<PlanChangeError["kind"], number> = {
  not_changeable: 409,
  same_plan: 409,
  unknown_plan: 422,
  interval_mismatch: 422,
};

export async function changeSubscriptionPlan({ deps, caller, id, body }: Context): Promise<Reply> {
  const found = findSubscription(deps, caller, id);
  if (!found.ok) return found.error;
  const input = parsePlanChange(body);
  if (!input.ok) return { status: 400, body: input.error };

  const change = await changePlan(deps, { subscription: found.value, planId: input.value.planId, at: deps.clock.now() });
  if (!change.ok) return { status: ERROR_STATUS[change.error.kind], body: change.error };
  if (change.value.kind === "downgrade") {
    return { status: 200, body: { subscription: change.value.subscription, invoice: null } };
  }
  return { status: 200, body: { subscription: change.value.subscription, invoice: change.value.invoice } };
}
