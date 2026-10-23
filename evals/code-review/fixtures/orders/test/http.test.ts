import assert from "node:assert/strict";
import { test } from "node:test";
import { startApp } from "./helpers.ts";

const { request } = await startApp();

async function placeMugOrder(token = "alice"): Promise<string> {
  const placed = await request("POST", "/orders", { token, body: { lines: [{ sku: "MUG-01", quantity: 1 }] } });
  assert.equal(placed.status, 201);
  return placed.body.id;
}

test("a customer places an order priced from the catalog", async () => {
  const placed = await request("POST", "/orders", {
    token: "alice",
    body: { lines: [{ sku: "MUG-01", quantity: 2 }, { sku: "TEE-M", quantity: 1 }] },
  });
  assert.equal(placed.status, 201);
  assert.equal(placed.body.customerId, "cus_alice");
  assert.equal(placed.body.subtotalCents, 4900);
  assert.equal(placed.body.totalCents, 5304);
});

test("requests without a known token are rejected", async () => {
  assert.equal((await request("GET", "/orders/id_1")).status, 401);
  assert.equal((await request("GET", "/orders/id_1", { token: "mallory" })).status, 401);
});

test("another customer's order looks like an unknown one", async () => {
  const id = await placeMugOrder();
  assert.equal((await request("GET", `/orders/${id}`, { token: "alice" })).status, 200);
  assert.deepEqual(await request("GET", `/orders/${id}`, { token: "bob" }), {
    status: 404,
    body: { kind: "order_not_found" },
  });
  assert.equal((await request("POST", `/orders/${id}/cancel`, { token: "bob" })).status, 404);
});

test("the owner pays and staff ship", async () => {
  const id = await placeMugOrder();
  const paid = await request("POST", `/orders/${id}/payment`, { token: "alice", body: { paymentRef: "pi_9" } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.paymentRef, "pi_9");
  assert.equal((await request("POST", `/orders/${id}/ship`, { token: "alice" })).status, 403);
  const shipped = await request("POST", `/orders/${id}/ship`, { token: "sam" });
  assert.equal(shipped.status, 200);
  assert.equal(shipped.body.status, "shipped");
});

test("an illegal transition answers 409", async () => {
  const id = await placeMugOrder();
  const shipped = await request("POST", `/orders/${id}/ship`, { token: "sam" });
  assert.deepEqual(shipped, { status: 409, body: { kind: "invalid_transition", from: "placed", to: "shipped" } });
});

test("bad bodies answer 400 and unknown SKUs 422", async () => {
  const empty = await request("POST", "/orders", { token: "alice", body: { lines: [] } });
  assert.equal(empty.status, 400);
  const unknown = await request("POST", "/orders", { token: "alice", body: { lines: [{ sku: "HAT", quantity: 1 }] } });
  assert.deepEqual(unknown, { status: 422, body: { kind: "unknown_sku", sku: "HAT" } });
});
