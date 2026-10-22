/** A stock-keeping unit: one sellable variant of a product. */
export interface Sku {
  readonly code: string;
  readonly productName: string;
  readonly priceCents: number;
}
