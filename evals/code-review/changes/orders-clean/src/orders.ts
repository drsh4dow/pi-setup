import { applyBasisPoints, type Cents } from "./money.ts";
import { err, ok, type Result } from "./result.ts";

export type OrderStatus = "placed" | "paid" | "shipped" | "cancelled" | "refunded";

export type RequestedLine = { sku: string; quantity: number };

export type LineItem = RequestedLine & { unitPriceCents: Cents };

export type Refund = { id: string; amountCents: Cents; reason: string; createdAt: string };

export type Order = {
  id: string;
  customerId: string;
  status: OrderStatus;
  lines: LineItem[];
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  placedAt: string;
  paymentRef?: string;
  paidAt?: string;
  shippedAt?: string;
  cancelledAt?: string;
  /** Oldest first. Refunds are only ever appended. */
  refunds: Refund[];
};

export type TransitionError = { kind: "invalid_transition"; from: OrderStatus; to: OrderStatus };

/** Sales tax on every order, in basis points (8.25%). */
export const TAX_BASIS_POINTS = 825;

/**
 * Returns the requested lines with their catalog prices, or an `unknown_sku` error naming the
 * first SKU the catalog doesn't carry.
 */
export function priceLines(
  requested: readonly RequestedLine[],
  catalog: ReadonlyMap<string, Cents>,
): Result<LineItem[], { kind: "unknown_sku"; sku: string }> {
  const lines: LineItem[] = [];
  for (const line of requested) {
    const unitPriceCents = catalog.get(line.sku);
    if (unitPriceCents === undefined) return err({ kind: "unknown_sku", sku: line.sku });
    lines.push({ ...line, unitPriceCents });
  }
  return ok(lines);
}

/** Returns a new `placed` order for the priced lines, with subtotal, tax, and total filled in. */
export function placeOrder(input: { id: string; customerId: string; lines: LineItem[]; at: Date }): Order {
  const subtotalCents = input.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  const taxCents = applyBasisPoints(subtotalCents, TAX_BASIS_POINTS);
  return {
    id: input.id,
    customerId: input.customerId,
    status: "placed",
    lines: input.lines,
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
    placedAt: input.at.toISOString(),
    refunds: [],
  };
}

/** Returns the order marked `paid`, or an `invalid_transition` error unless it is `placed`. */
export function markPaid(order: Order, input: { paymentRef: string; at: Date }): Result<Order, TransitionError> {
  if (order.status !== "placed") return err(invalidTransition(order, "paid"));
  return ok({ ...order, status: "paid", paymentRef: input.paymentRef, paidAt: input.at.toISOString() });
}

/** Returns the order marked `shipped`, or an `invalid_transition` error unless it is `paid`. */
export function markShipped(order: Order, input: { at: Date }): Result<Order, TransitionError> {
  if (order.status !== "paid") return err(invalidTransition(order, "shipped"));
  return ok({ ...order, status: "shipped", shippedAt: input.at.toISOString() });
}

/**
 * Returns the order marked `cancelled`, or an `invalid_transition` error unless it is
 * `placed`. A paid order can't be cancelled; its money has already moved.
 */
export function cancelOrder(order: Order, input: { at: Date }): Result<Order, TransitionError> {
  if (order.status !== "placed") return err(invalidTransition(order, "cancelled"));
  return ok({ ...order, status: "cancelled", cancelledAt: input.at.toISOString() });
}

function invalidTransition(order: Order, to: OrderStatus): TransitionError {
  return { kind: "invalid_transition", from: order.status, to };
}
