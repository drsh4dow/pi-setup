export function formatItemV1(item) {
  return { item_id: item.id, item_name: item.name, cat: item.category, qty: item.stock, v: 1 };
}
