import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAccountLabels, updateCredentialBlob } from "../keychain.ts";

test("buildAccountLabels: single account uses bare tier label", () => {
  const labels = buildAccountLabels([
    {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 0,
      subscriptionType: "max",
    },
  ]);
  assert.deepEqual(labels, ["Claude Max"]);
});

test("buildAccountLabels: missing subscriptionType falls back to Claude", () => {
  const labels = buildAccountLabels([
    { accessToken: "a", refreshToken: "r", expiresAt: 0 },
  ]);
  assert.deepEqual(labels, ["Claude"]);
});

test("buildAccountLabels: duplicate tiers get numeric suffixes", () => {
  const labels = buildAccountLabels([
    {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 0,
      subscriptionType: "pro",
    },
    {
      accessToken: "b",
      refreshToken: "s",
      expiresAt: 0,
      subscriptionType: "pro",
    },
  ]);
  assert.deepEqual(labels, ["Claude Pro 1", "Claude Pro 2"]);
});

test("updateCredentialBlob: updates a wrapped claudeAiOauth blob", () => {
  const input = JSON.stringify({
    claudeAiOauth: {
      accessToken: "old",
      refreshToken: "oldR",
      expiresAt: 1,
      subscriptionType: "max",
    },
  });
  const out = updateCredentialBlob(input, {
    accessToken: "new",
    refreshToken: "newR",
    expiresAt: 2,
  });
  assert.ok(out);
  const parsed = JSON.parse(out) as {
    claudeAiOauth: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      subscriptionType: string;
    };
  };
  assert.equal(parsed.claudeAiOauth.accessToken, "new");
  assert.equal(parsed.claudeAiOauth.refreshToken, "newR");
  assert.equal(parsed.claudeAiOauth.expiresAt, 2);
  // Preserves unrelated fields
  assert.equal(parsed.claudeAiOauth.subscriptionType, "max");
});

test("updateCredentialBlob: updates a flat blob", () => {
  const input = JSON.stringify({
    accessToken: "old",
    refreshToken: "oldR",
    expiresAt: 1,
  });
  const out = updateCredentialBlob(input, {
    accessToken: "new",
    refreshToken: "newR",
    expiresAt: 2,
  });
  assert.ok(out);
  const parsed = JSON.parse(out) as { accessToken: string };
  assert.equal(parsed.accessToken, "new");
});

test("updateCredentialBlob: returns null for malformed json", () => {
  assert.equal(
    updateCredentialBlob("not json", {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 0,
    }),
    null,
  );
});
