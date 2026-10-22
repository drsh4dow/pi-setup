import type { Sku } from "./catalog.ts";

export interface CartLine {
  readonly sku: Sku;
  readonly quantity: number;
}

/** A shopper's cart before checkout. Lines merge by SKU. */
export class Cart {
  readonly lines: CartLine[] = [];

  add(sku: Sku, quantity: number) {
    const line = this.lines.find((existing) => existing.sku.code === sku.code);

    if (line) {
      this.lines[this.lines.indexOf(line)] = { sku, quantity: line.quantity + quantity };
      return;
    }

    this.lines.push({ sku, quantity });
  }

  subtotalCents() {
    return this.lines.reduce((sum, line) => sum + line.sku.priceCents * line.quantity, 0);
  }
}
