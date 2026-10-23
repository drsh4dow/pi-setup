import assert from "node:assert/strict";
import { test } from "node:test";
import { startApp } from "./http-helpers.ts";

const { request, deps } = await startApp();

test("a plan with a trial starts trialing without an invoice", async () => {
  const { status, body } = await request("POST", "/subscriptions", { token: "alice", body: { planId: "pro" } });
  assert.equal(status, 201);
  assert.equal(body.subscription.status, "trialing");
  assert.equal(body.subscription.currentPeriodEnd, "2026-03-15T00:00:00.000Z");
  assert.equal(body.invoice, null);
});

test("a plan without a trial is invoiced and charged at signup", async () => {
  const { status, body } = await request("POST", "/subscriptions", { token: "alice", body: { planId: "business" } });
  assert.equal(status, 201);
  assert.equal(body.subscription.status, "active");
  assert.equal(body.invoice.status, "paid");
  assert.equal(body.invoice.totalCents, 10_230);
});

test("archived and unknown plans take no signups", async () => {
  for (const planId of ["legacy-basic", "gold"]) {
    const { status, body } = await request("POST", "/subscriptions", { token: "alice", body: { planId } });
    assert.equal(status, 422);
    assert.deepEqual(body, { kind: "unknown_plan", planId });
  }
});

test("the plan list leaves out archived plans", async () => {
  const { body } = await request("GET", "/plans", { token: "bob" });
  assert.deepEqual(
    body.map((plan: { id: string }) => plan.id),
    ["starter", "pro", "business", "pro-yearly"],
  );
});

test("a customer can set their subscription to cancel at period end", async () => {
  const created = await request("POST", "/subscriptions", { token: "alice", body: { planId: "starter" } });
  const { status, body } = await request("PATCH", `/subscriptions/${created.body.subscription.id}`, {
    token: "alice",
    body: { cancelAtPeriodEnd: true },
  });
  assert.equal(status, 200);
  assert.equal(body.cancelAtPeriodEnd, true);
  assert.equal(deps.store.getSubscription(body.id)?.cancelAtPeriodEnd, true);
});

test("a bad update answers 400", async () => {
  const created = await request("POST", "/subscriptions", { token: "alice", body: { planId: "starter" } });
  const { status, body } = await request("PATCH", `/subscriptions/${created.body.subscription.id}`, {
    token: "alice",
    body: { cancelAtPeriodEnd: "yes" },
  });
  assert.equal(status, 400);
  assert.equal(body.kind, "invalid_input");
});

test("another customer's subscription answers 404, an admin's view 200", async () => {
  const created = await request("POST", "/subscriptions", { token: "alice", body: { planId: "starter" } });
  const path = `/subscriptions/${created.body.subscription.id}`;
  assert.equal((await request("GET", path, { token: "bob" })).status, 404);
  assert.equal((await request("PATCH", path, { token: "bob", body: { cancelAtPeriodEnd: true } })).status, 404);
  assert.equal((await request("GET", path, { token: "ada" })).status, 200);
});

test("invoices list newest first", async () => {
  const created = await request("POST", "/subscriptions", { token: "alice", body: { planId: "business" } });
  const { status, body } = await request("GET", `/subscriptions/${created.body.subscription.id}/invoices`, { token: "alice" });
  assert.equal(status, 200);
  assert.deepEqual(body.map((invoice: { id: string }) => invoice.id), [created.body.invoice.id]);
});

test("an endpoint's secret is shown once, at creation", async () => {
  const created = await request("POST", "/webhook-endpoints", {
    token: "ada",
    body: { url: "https://example.com/hooks", events: ["invoice.paid"] },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.secret, /^whsec_/);

  const listed = await request("GET", "/webhook-endpoints", { token: "ada" });
  assert.ok(listed.body.every((endpoint: object) => !("secret" in endpoint)));
});

test("customers can't manage webhook endpoints", async () => {
  const { status } = await request("POST", "/webhook-endpoints", {
    token: "alice",
    body: { url: "https://example.com/hooks", events: ["invoice.paid"] },
  });
  assert.equal(status, 403);
});

test("requests without a known token answer 401", async () => {
  assert.equal((await request("GET", "/plans")).status, 401);
  assert.equal((await request("GET", "/plans", { token: "mallory" })).status, 401);
});
