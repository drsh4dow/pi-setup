import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { server } from "../src/server.js";

test("GET /users returns users", async () => {
  server.listen(0);
  await once(server, "listening");
  const response = await fetch(`http://localhost:${server.address().port}/users`, { headers: { "x-user": "ada" } });
  assert.deepEqual(await response.json(), { users: ["ada", "grace"], requestedBy: "ada" });
  server.close();
});
