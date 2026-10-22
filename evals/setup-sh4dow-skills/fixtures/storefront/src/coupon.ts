import type { Cart } from "./cart.ts";

/** A code a shopper enters for a percentage off the cart subtotal. */
export interface Coupon {
  readonly code: string;
  readonly percentOff: number;
  readonly expiresAt: Date;
}

export function discountCents(cart: Cart, coupon: Coupon, now: Date) {
  if (now > coupon.expiresAt) return 0;

  return Math.floor((cart.subtotalCents() * coupon.percentOff) / 100);
}
