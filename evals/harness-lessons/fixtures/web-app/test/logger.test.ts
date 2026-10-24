import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { log } from "../src/logger.ts";

test("log writes one JSON line with a timestamp and the level", () => {
  const print = mock.method(console, "log", () => {});

  try {
    log("warn", "low stock", { sku: "mug" });
  } finally {
    print.mock.restore();
  }

  assert.equal(print.mock.callCount(), 1);

  const line = JSON.parse(String(print.mock.calls[0].arguments[0]));

  assert.equal(line.level, "warn");
  assert.equal(line.sku, "mug");
  assert.match(line.at, /^\d{4}-\d{2}-\d{2}T/);
});
