import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/load-config.js";

test("applies defaults under the file's values", () => {
  const config = loadConfig(new URL("../config.json", import.meta.url).pathname);
  assert.equal(config.port, 9000);
  assert.equal(config.logLevel, "info");
  assert.deepEqual(config.database, { host: "db.internal", port: 5432 });
});
