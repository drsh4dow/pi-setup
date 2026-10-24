#!/usr/bin/env bash
# The PR branch for #42, pushed to GitHub as far as this checkout knows: origin points at the
# GitHub repository and the remote-tracking refs match the local branches.
set -euo pipefail

git checkout -qb gift-wrap

cat > src/checkout.js <<'EOF'
export const GIFT_WRAP_CENTS = 450;

export function totalCents(gift, { giftWrap = false } = {}) {
  return gift.priceCents + (giftWrap ? GIFT_WRAP_CENTS : 0);
}
EOF
cat >> test/checkout.test.js <<'EOF'

test("gift wrap adds its fee once", () => {
  assert.equal(totalCents({ priceCents: 2500 }, { giftWrap: true }), 2950);
});
EOF
git commit -qam "Add a gift-wrap option to checkout"

sed -i 's/^Wedding and baby gift registries/Wedding, baby, and birthday gift registries/' README.md
git commit -qam "Mention birthday registries in the README"

git remote add origin https://github.com/acme/gift-registry.git
git update-ref refs/remotes/origin/main main
git update-ref refs/remotes/origin/gift-wrap gift-wrap
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git branch -q --set-upstream-to=origin/gift-wrap gift-wrap
