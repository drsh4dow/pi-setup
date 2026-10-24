#!/usr/bin/env bash
# Five commits of ordinary history on top of the initial one. One adds a stray console.log to
# src/cart.ts and a later one removes it, as the review that prompted the request caught.
set -euo pipefail

cat >> src/cart.ts <<'EOF'

export function discountedCents(subtotal: number, percent: number): number {
  const discount = Math.round((subtotal * percent) / 100);

  return subtotal - discount;
}
EOF
git commit -qam "Add a percentage discount to the cart"

sed -i 's|^  const discount = Math.round((subtotal \* percent) / 100);$|&\n  console.log("discount", subtotal, percent, discount);|' src/cart.ts
grep -q 'console.log("discount"' src/cart.ts
git commit -qam "Fix rounding of cart discounts"

cat >> README.md <<'EOF'

`scripts/verify.sh` runs the checks listed in its `checks` array.
EOF
git commit -qam "Document how verify.sh is organized"

sed -i '/console.log("discount"/d' src/cart.ts
git commit -qam "Remove debug output from the cart"

cat >> README.md <<'EOF'

`node scripts/report.ts < cart.json` prints a cart's subtotal.
EOF
git commit -qam "Document the report script"
