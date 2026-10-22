import assert from "node:assert/strict";
import { test } from "node:test";
import { allow } from "../src/limiter.js";

test("allows 60 requests per minute per IP", () => {
  for (let i = 0; i < 60; i++) assert.equal(allow("10.0.0.1", 1000 + i), true);
  assert.equal(allow("10.0.0.1", 2000), false);
  assert.equal(allow("10.0.0.2", 2000), true);
});
