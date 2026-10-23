import type { AddressInfo } from "node:net";
import { after } from "node:test";
import type { Caller } from "../src/auth.ts";
import { createOrdersServer } from "../src/http.ts";
import { OrderStore } from "../src/store.ts";

export const NOW = new Date("2026-03-02T10:00:00.000Z");

export const CATALOG = new Map([
  ["MUG-01", 1200],
  ["TEE-M", 2500],
]);

const TOKENS = new Map<string, Caller>([
  ["alice", { kind: "customer", customerId: "cus_alice" }],
  ["bob", { kind: "customer", customerId: "cus_bob" }],
  ["sam", { kind: "staff", staffId: "stf_sam" }],
]);

export type Client = (
  method: string,
  path: string,
  options?: { token?: string; body?: unknown },
) => Promise<{ status: number; body: any }>;

/** Starts the API on a free port with a fixed clock and sequential ids, and stops it after the file's tests. */
export async function startApp(): Promise<{ request: Client; store: OrderStore }> {
  let nextId = 1;
  const store = new OrderStore();
  const server = createOrdersServer({
    store,
    tokens: TOKENS,
    catalog: CATALOG,
    clock: { now: () => NOW },
    newId: () => `id_${nextId++}`,
    logError: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const request: Client = async (method, path, { token, body } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: response.status, body: await response.json() };
  };
  return { request, store };
}
