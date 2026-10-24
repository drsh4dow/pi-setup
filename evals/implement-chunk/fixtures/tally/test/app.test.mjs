import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/app.mjs";

const get = (path) => handle(new URL(path, "http://localhost"));

test("health answers ok", async () => {
  assert.deepEqual(await get("/health"), { status: 200, body: { ok: true } });
});

test("an unknown path is a 404", async () => {
  assert.equal((await get("/nope")).status, 404);
});
