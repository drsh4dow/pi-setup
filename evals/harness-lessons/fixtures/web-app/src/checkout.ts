import { subtotalCents, type LineItem } from "./cart.ts";
import { log } from "./logger.ts";

export function checkout(orderId: string, items: readonly LineItem[]): number {
  const total = subtotalCents(items);

  log("info", "checkout", { orderId, totalCents: total, lines: items.length });

  return total;
}
