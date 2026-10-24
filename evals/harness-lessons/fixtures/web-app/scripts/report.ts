// Prints the subtotal of the cart JSON given on stdin.
import { readFileSync } from "node:fs";
import { subtotalCents } from "../src/cart.ts";

const items = JSON.parse(readFileSync(0, "utf8"));

console.log(`subtotal: ${(subtotalCents(items) / 100).toFixed(2)}`);
