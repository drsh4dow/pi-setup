import type { Order } from "./orders.ts";

export type Caller = { kind: "customer"; customerId: string } | { kind: "staff"; staffId: string };

/**
 * Returns the caller that owns the bearer token in an `Authorization` header, or undefined
 * when the header is missing, malformed, or names an unknown token.
 */
export function authenticate(header: string | undefined, tokens: ReadonlyMap<string, Caller>): Caller | undefined {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  return token === undefined ? undefined : tokens.get(token);
}

/** Returns whether the caller may see and act on the order: its own customer, or any staff member. */
export function canAccess(caller: Caller, order: Order): boolean {
  return caller.kind === "staff" || caller.customerId === order.customerId;
}
