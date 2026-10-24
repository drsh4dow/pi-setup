import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyTotalLine } from "../src/legacy.js";

test("the legacy total line", () => {
  assert.equal(legacyTotalLine(1234), "TOTAL 12.34 USD");
});
