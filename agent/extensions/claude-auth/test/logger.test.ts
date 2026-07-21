import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../logger.ts";

test("redact: refreshToken is fully redacted", () => {
  const out = redact({ refreshToken: "super-secret-token" });
  assert.equal(out.refreshToken, "REDACTED");
});

test("redact: accessToken keeps an 8-char prefix only", () => {
  const out = redact({ accessToken: "sk-ant-oat-0123456789" });
  assert.equal(out.accessToken, "sk-ant-o...REDACTED");
});

test("redact: x-api-key is fully redacted", () => {
  const out = redact({ "x-api-key": "sk-ant-api-xyz" });
  assert.equal(out["x-api-key"], "REDACTED");
});

test("redact: JWT-shaped values are truncated", () => {
  const jwt = "eyJhbGciOiJIUzI1NientirelyfakepayloaddatahereXYZ";
  const out = redact({ token: jwt });
  assert.equal(out.token, `${jwt.slice(0, 8)}...REDACTED`);
});

test("redact: non-string and benign values pass through", () => {
  const out = redact({ status: 200, source: "file", ok: true });
  assert.deepEqual(out, { status: 200, source: "file", ok: true });
});
