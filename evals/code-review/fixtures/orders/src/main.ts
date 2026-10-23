import { randomUUID } from "node:crypto";
import type { Caller } from "./auth.ts";
import { createOrdersServer } from "./http.ts";
import { OrderStore } from "./store.ts";

// Demo data for local runs. Production wires the catalog and tokens from their services.
const catalog = new Map([
  ["MUG-01", 1200],
  ["TEE-M", 2500],
  ["POSTER-A2", 1800],
]);

const tokens = new Map<string, Caller>([
  ["dev-customer", { kind: "customer", customerId: "cus_demo" }],
  ["dev-staff", { kind: "staff", staffId: "stf_demo" }],
]);

const server = createOrdersServer({
  store: new OrderStore(),
  tokens,
  catalog,
  clock: { now: () => new Date() },
  newId: () => `ord_${randomUUID()}`,
  logError: (error) => console.error(error),
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`orders listening on http://localhost:${port}`));
