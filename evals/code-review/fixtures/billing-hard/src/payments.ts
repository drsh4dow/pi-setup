import type { Cents } from "./money.ts";
import type { Result } from "./result.ts";

export type ChargeRequest = {
  customerId: string;
  amountCents: Cents;
  /** The provider charges a key at most once and answers repeats with the first outcome. */
  idempotencyKey: string;
};

export type ChargeError = { kind: "card_declined" } | { kind: "provider_unavailable" };

/** The card processor. Charges the customer's card on file. */
export type PaymentProvider = {
  charge(request: ChargeRequest): Promise<Result<{ chargeId: string }, ChargeError>>;
};
