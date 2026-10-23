import type { Cents } from "./money.ts";
import type { Order, OrderStatus, Refund } from "./orders.ts";
import { err, ok, type Result } from "./result.ts";

export type RefundError =
  | { kind: "not_refundable"; status: OrderStatus }
  | { kind: "exceeds_balance"; remainingCents: Cents };

/** Returns the cents the order can still refund: its total minus the refunds it already has. */
export function refundableCents(order: Order): Cents {
  return order.refunds.reduce((balanceCents, refund) => balanceCents - refund.amountCents, order.totalCents);
}

/**
 * Returns the order with the refund appended, marked `refunded` when its refunds reach its
 * total. Fails with `not_refundable` unless the order is `paid` or `shipped`, and with
 * `exceeds_balance` when the amount is more than the order can still refund.
 */
export function refundOrder(
  order: Order,
  input: { id: string; amountCents: Cents; reason: string; at: Date },
): Result<Order, RefundError> {
  if (order.status !== "paid" && order.status !== "shipped") {
    return err({ kind: "not_refundable", status: order.status });
  }
  const remainingCents = refundableCents(order);
  if (input.amountCents > remainingCents) return err({ kind: "exceeds_balance", remainingCents });

  const refund: Refund = {
    id: input.id,
    amountCents: input.amountCents,
    reason: input.reason,
    createdAt: input.at.toISOString(),
  };
  return ok({
    ...order,
    status: input.amountCents === remainingCents ? "refunded" : order.status,
    refunds: [...order.refunds, refund],
  });
}
