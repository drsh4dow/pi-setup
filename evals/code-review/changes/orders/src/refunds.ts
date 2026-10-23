import type { Cents } from "./money.ts";
import type { Order, OrderStatus } from "./orders.ts";
import { err, ok, type Result } from "./result.ts";

export type RefundError =
  | { kind: "not_refundable"; status: OrderStatus }
  | { kind: "exceeds_balance"; remainingCents: Cents };

const REFUNDABLE: ReadonlySet<OrderStatus> = new Set(["paid", "shipped"]);

/**
 * Returns the order with a refund of `amountCents` added, marked `refunded` once its refunds
 * reach its total. Fails with `not_refundable` unless the order is paid or shipped, and with
 * `exceeds_balance` when the refund is more than is left to refund.
 */
export function refundOrder(
  order: Order,
  input: { id: string; amountCents: Cents; reason: string },
): Result<Order, RefundError> {
  if (!REFUNDABLE.has(order.status)) return err({ kind: "not_refundable", status: order.status });
  if (input.amountCents > order.totalCents) {
    return err({ kind: "exceeds_balance", remainingCents: order.totalCents - order.refundedCents });
  }

  // Build the refund record from the input and the current time. Then add the refund
  // amount to the running total of refunded cents for this order. If the new total
  // equals the order total, the order has been fully refunded, so we set its status to
  // "refunded"; otherwise we keep the status it already had. Finally, we return a copy
  // of the order with the new refund appended to its list of refunds.
  const refund = { id: input.id, amountCents: input.amountCents, reason: input.reason, createdAt: new Date().toISOString() };
  const refundedCents = order.refundedCents + input.amountCents;
  const status: OrderStatus = refundedCents === order.totalCents ? "refunded" : order.status;
  return ok({ ...order, status, refunds: [...order.refunds, refund], refundedCents });
}
