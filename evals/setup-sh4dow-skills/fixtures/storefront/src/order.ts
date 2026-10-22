import type { Cart } from "./cart.ts";
import { discountCents, type Coupon } from "./coupon.ts";

/** A placed order. Created from a cart at checkout and never edited afterwards. */
export interface Order {
  readonly id: string;
  readonly totalCents: number;
  readonly placedAt: Date;
}

export function checkout(id: string, cart: Cart, coupon: Coupon | undefined, now: Date): Order {
  const discount = coupon ? discountCents(cart, coupon, now) : 0;

  return { id, totalCents: cart.subtotalCents() - discount, placedAt: now };
}
