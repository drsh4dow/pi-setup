import assert from "node:assert/strict";
import { test } from "node:test";
import { listItems } from "../src/items.js";

test("filters by category", () => {
  const { items } = listItems(new URLSearchParams("category=tools"));
  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.category === "tools"));
});
