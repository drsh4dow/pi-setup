import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv, summarize } from "../src/stats.js";

test("summarizes a numeric column", () => {
  const rows = parseCsv("name,score\nada,3\ngrace,5\n");
  assert.deepEqual(summarize(rows, "score"), { count: 2, min: 3, max: 5, mean: 4 });
});
