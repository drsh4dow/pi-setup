export interface LineItem {
  readonly sku: string;
  readonly unitCents: number;
  readonly quantity: number;
}

export function subtotalCents(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
}

export function addItem(items: readonly LineItem[], item: LineItem): LineItem[] {
  const existing = items.find((line) => line.sku === item.sku);

  if (!existing) return [...items, item];

  return items.map((line) =>
    line.sku === item.sku ? { ...line, quantity: line.quantity + item.quantity } : line,
  );
}
