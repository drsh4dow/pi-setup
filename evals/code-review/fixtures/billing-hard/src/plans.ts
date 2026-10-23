import type { Cents } from "./money.ts";
import type { Interval } from "./periods.ts";

export type PlanId = string;

export type Plan = {
  id: PlanId;
  name: string;
  interval: Interval;
  /** The price of one period. */
  priceCents: Cents;
  trialDays: number;
  /** Archived plans take no new subscriptions; subscriptions already on them keep renewing. */
  archived: boolean;
};

/** The plans the service sells, looked up by id. */
export class PlanCatalog {
  readonly #plans: ReadonlyMap<PlanId, Plan>;

  constructor(plans: readonly Plan[]) {
    this.#plans = new Map(plans.map((plan) => [plan.id, plan]));
  }

  /** Returns the plan with this id, archived or not, or undefined for an unknown id. */
  get(id: PlanId): Plan | undefined {
    return this.#plans.get(id);
  }

  /** Returns the plan with this id if new subscriptions may use it: it exists and isn't archived. */
  forSignup(id: PlanId): Plan | undefined {
    const plan = this.#plans.get(id);
    if (!plan || plan.archived) return undefined;
    return plan;
  }

  /** Returns the plans open for signup, cheapest first. */
  listed(): Plan[] {
    return [...this.#plans.values()].filter((plan) => !plan.archived).toSorted((a, b) => a.priceCents - b.priceCents);
  }
}

export const DEMO_PLANS: readonly Plan[] = [
  { id: "starter", name: "Starter", interval: "month", priceCents: 1_000, trialDays: 14, archived: false },
  { id: "pro", name: "Pro", interval: "month", priceCents: 3_100, trialDays: 14, archived: false },
  { id: "business", name: "Business", interval: "month", priceCents: 9_300, trialDays: 0, archived: false },
  { id: "pro-yearly", name: "Pro (yearly)", interval: "year", priceCents: 31_000, trialDays: 14, archived: false },
  { id: "legacy-basic", name: "Basic (2019)", interval: "month", priceCents: 400, trialDays: 0, archived: true },
];
