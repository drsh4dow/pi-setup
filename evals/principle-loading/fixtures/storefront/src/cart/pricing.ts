import type { LineItem } from "../db.ts";

export type Region = "US" | "EU";

export type Cart = {
  items: LineItem[];
  region: Region;
  discountCode?: string;
};

export type PriceBreakdown = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
};

const DISCOUNT_CODES: Record<string, { kind: "percent"; percent: number } | { kind: "fixed"; cents: number }> = {
  SAVE10: { kind: "percent", percent: 10 },
  FIVEOFF: { kind: "fixed", cents: 500 },
};

const TAX_RATE: Record<Region, number> = { US: 0.07, EU: 0.2 };

const FREE_SHIPPING_THRESHOLD_CENTS = 5000;

const SHIPPING_CENTS = 499;

export function priceCart(cart: Cart): PriceBreakdown {
  const subtotalCents = cart.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);

  let discountCents = 0;
  const discount = cart.discountCode ? DISCOUNT_CODES[cart.discountCode.toUpperCase()] : undefined;
  if (discount?.kind === "percent") discountCents = Math.round((subtotalCents * discount.percent) / 100);
  if (discount?.kind === "fixed") discountCents = Math.min(discount.cents, subtotalCents);

  const discountedCents = subtotalCents - discountCents;
  const shippingCents = discountedCents >= FREE_SHIPPING_THRESHOLD_CENTS || discountedCents === 0 ? 0 : SHIPPING_CENTS;
  const taxCents = Math.round(discountedCents * TAX_RATE[cart.region]);

  return {
    subtotalCents,
    discountCents,
    shippingCents,
    taxCents,
    totalCents: discountedCents + shippingCents + taxCents,
  };
}
