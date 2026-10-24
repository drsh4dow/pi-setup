// Prints a sample cart as JSON, for pasting into the dev console.
import { addItem, type LineItem } from "../src/cart.ts";

let items: LineItem[] = [];

items = addItem(items, { sku: "mug", unitCents: 1200, quantity: 2 });
items = addItem(items, { sku: "tea", unitCents: 850, quantity: 1 });

console.log(JSON.stringify(items, null, 2));
