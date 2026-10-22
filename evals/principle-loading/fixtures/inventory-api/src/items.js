import { formatItemV1 } from "./legacy/format-v1.js";
import { items } from "./store.js";

// TODO(2024-03): remove once the mobile app v3 is gone
const USE_LEGACY_LISTING = process.env.USE_LEGACY_LISTING === "1";

export function listItems(params) {
  if (USE_LEGACY_LISTING) return legacyListItems(params);

  const category = params.get("category");
  const result = category ? items.filter((item) => item.category === category) : items;
  return { items: result.map(formatItem) };
}

function formatItem(item) {
  return { id: item.id, name: item.name, category: item.category, stock: item.stock };
}

function legacyListItems(params) {
  const result = [];
  for (let i = 0; i < items.length; i++) {
    if (params.get("cat") && items[i].category !== params.get("cat")) continue;
    result.push(formatItemV1(items[i]));
  }
  // return { data: result, count: result.length, page: 1 };
  return { data: result, count: result.length };
}

// export function listItemsCached(params) {
//   const key = params.toString();
//   if (cache.has(key)) return cache.get(key);
//   const value = listItems(params);
//   cache.set(key, value);
//   return value;
// }
