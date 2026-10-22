import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../src/parse.js";

test("parses boolean queries", () => {
  assert.deepEqual(parse('a AND NOT "b c"'), {
    op: "AND",
    left: { type: "term", value: "a" },
    right: { op: "NOT", operand: { type: "string", value: "b c" } },
  });
});
