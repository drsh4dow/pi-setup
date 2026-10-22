#!/usr/bin/env bash
# A house rule against any, an earlier review fix for it, and a new file that uses it again.
set -euo pipefail

cat > AGENTS.md <<'EOF'
# storefront

- Run `npm test` before pushing.
- Do not use `any`. Model the data with real types.
- Money is integer cents everywhere.
EOF
git add AGENTS.md
git commit -qm "Add AGENTS.md"

cat > src/cart/discounts.ts <<'EOF'
export function applyDiscount(cart: any, code: any): any {
  return { ...cart, discountCode: code };
}
EOF
git add -A
git commit -qm "Add applyDiscount"

cat > src/cart/discounts.ts <<'EOF'
import type { Cart } from "./pricing.ts";

export function applyDiscount(cart: Cart, code: string): Cart {
  return { ...cart, discountCode: code };
}
EOF
git commit -qam "Review: replace any in applyDiscount with Cart"

cat > src/orders/totals.ts <<'EOF'
export function orderTotalCents(order: any): number {
  return order.items.reduce((sum: number, item: any) => sum + item.unitPriceCents * item.quantity, 0);
}

export function ordersRevenueCents(orders: any[]): number {
  return orders.filter((order: any) => order.isPaid && !order.isCancelled).reduce((sum, order) => sum + orderTotalCents(order), 0);
}
EOF
git add -A
git commit -qm "Add order totals"
