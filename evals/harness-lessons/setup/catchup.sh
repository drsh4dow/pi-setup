#!/usr/bin/env bash
# The gift-registry repository as the seeded chat left it (see catchup-chat.ts): main has split
# gifts, registry pages, and search; fix-split-cent, page-size-50, and search-index hold the
# commits behind PRs #51, #52, and #53; the two screenshots of the split-gift page sit untracked
# in evidence/; HEAD is on page-size-50, where the chat last ran the tests. origin is a local bare
# repository named gift-registry holding main and the three branches, as the chat's pushes left
# it, so nothing reaches the network and the run's state folder is named gift-registry.
set -euo pipefail

HERE="$(dirname "$(readlink -f "$0")")"

commit() {
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -qm "$2"
}

mkdir -p migrations test

cat > src/checkout.js <<'EOF'
export function totalCents(gift) {
  return gift.priceCents;
}

/** What each guest pays when `guests` split a gift. */
export function shareCents(gift, guests) {
  return Math.floor(gift.priceCents / guests);
}
EOF
cat >> test/checkout.test.js <<'EOF'

test("three guests each pay a third", () => {
  assert.equal(shareCents({ priceCents: 3000 }, 3), 1000);
});
EOF
sed -i 's/import { totalCents }/import { shareCents, totalCents }/' test/checkout.test.js
git add -A
commit "2026-10-20T10:12:00Z" "Let guests split a gift"

cat > migrations/0041_create_gifts.sql <<'EOF'
CREATE TABLE gifts (
  id BIGSERIAL PRIMARY KEY,
  registry_id BIGINT NOT NULL REFERENCES registries (id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  bought BOOLEAN NOT NULL DEFAULT FALSE
);
EOF
cat > src/registry.js <<'EOF'
export const PAGE_SIZE = 20;

/** The gifts on one page of a registry, counting pages from 1. */
export function registryPage(gifts, page) {
  return gifts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

export function pageCount(gifts) {
  return Math.max(1, Math.ceil(gifts.length / PAGE_SIZE));
}
EOF
cat > src/search.js <<'EOF'
/** The gifts of one registry whose name contains `query`, ignoring case. */
export function searchGifts(gifts, registryId, query) {
  const needle = query.trim().toLowerCase();

  return gifts.filter(
    (gift) => gift.registryId === registryId && gift.name.toLowerCase().includes(needle),
  );
}
EOF
cat > test/registry.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { pageCount, registryPage } from "../src/registry.js";

const gifts = Array.from({ length: 130 }, (_, index) => ({ id: index + 1 }));

test("a registry page shows 20 gifts", () => {
  assert.equal(registryPage(gifts, 1).length, 20);
});

test("the second page starts where the first ends", () => {
  assert.equal(registryPage(gifts, 2)[0].id, registryPage(gifts, 1).at(-1).id + 1);
});

test("the last page holds the rest", () => {
  assert.ok(registryPage(gifts, pageCount(gifts)).length > 0);
});

test("an empty registry has one empty page", () => {
  assert.equal(pageCount([]), 1);
  assert.deepEqual(registryPage([], 1), []);
});
EOF
cat > test/search.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { searchGifts } from "../src/search.js";

const gifts = [
  { registryId: 1, name: "Stand mixer" },
  { registryId: 1, name: "Mixer bowl" },
  { registryId: 1, name: "Picnic blanket" },
  { registryId: 2, name: "Stand mixer" },
];

const names = (found) => found.map((gift) => gift.name);

test("search finds gifts by name", () => {
  assert.deepEqual(names(searchGifts(gifts, 1, "blanket")), ["Picnic blanket"]);
});

test("search ignores case", () => {
  assert.deepEqual(names(searchGifts(gifts, 1, "MIXER")), ["Stand mixer", "Mixer bowl"]);
});

test("search stays inside one registry", () => {
  assert.equal(searchGifts(gifts, 2, "mixer").length, 1);
});

test("an empty query lists every gift", () => {
  assert.equal(searchGifts(gifts, 1, "  ").length, 3);
});

test("no match finds nothing", () => {
  assert.deepEqual(searchGifts(gifts, 1, "toaster"), []);
});

test("search ranks exact names first", { skip: "todo" }, () => {});
EOF
git add -A
commit "2026-10-21T15:40:00Z" "Add registry pages and gift search"

git checkout -qb fix-split-cent
cat > src/checkout.js <<'EOF'
export function totalCents(gift) {
  return gift.priceCents;
}

/**
 * Each guest's share when `guests` split a price. The shares add up to the price: the first
 * guests to pay take the leftover cents.
 */
export function splitShares(priceCents, guests) {
  const base = Math.floor(priceCents / guests);
  const leftover = priceCents - base * guests;

  return Array.from({ length: guests }, (_, index) => base + (index < leftover ? 1 : 0));
}
EOF
cat > test/checkout.test.js <<'EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitShares, totalCents } from "../src/checkout.js";

test("a gift costs its price", () => {
  assert.equal(totalCents({ priceCents: 2500 }), 2500);
});

test("three guests splitting $100 pay $100 in all", () => {
  assert.equal(
    splitShares(10000, 3).reduce((sum, share) => sum + share, 0),
    10000,
  );
});

test("the first guest pays the leftover cent", () => {
  assert.deepEqual(splitShares(10000, 3), [3334, 3333, 3333]);
});
EOF
git add -A
commit "2026-10-24T14:24:00Z" "Fix split gifts losing a cent"

git checkout -q main
git checkout -qb search-index
printf 'CREATE INDEX gifts_registry_id_idx ON gifts (registry_id);' > migrations/0042_gifts_registry_id.sql
git add -A
commit "2026-10-24T14:58:00Z" "Add an index on gifts.registry_id"

git checkout -q main
git checkout -qb page-size-50
sed -i 's/PAGE_SIZE = 20/PAGE_SIZE = 50/' src/registry.js
sed -i 's/shows 20 gifts/shows 50 gifts/; s/length, 20)/length, 50)/' test/registry.test.js
git add -A
commit "2026-10-24T14:47:00Z" "Show 50 gifts per registry page"

origin="$(mktemp -d)/gift-registry.git"
git init -q --bare -b main "$origin"
git remote add origin "$origin"
git push -q -u origin main fix-split-cent search-index page-size-50
git remote set-head origin main

mkdir -p evidence
cp "$HERE/catchup/checkout-before.png" "$HERE/catchup/checkout-after.png" evidence/

git status --porcelain=v1 --untracked-files=all > "$SETUP_OUTPUT/setup-status.txt"
