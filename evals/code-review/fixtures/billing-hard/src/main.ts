import type { Caller } from "./auth.ts";
import { renewDue } from "./billing.ts";
import { runDunning } from "./dunning.ts";
import { createBillingServer } from "./http/server.ts";
import type { HttpDeps } from "./http/replies.ts";
import { ok } from "./result.ts";
import { DEMO_PLANS, PlanCatalog } from "./plans.ts";
import { BillingStore } from "./store.ts";
import { WebhookPublisher } from "./webhooks.ts";

const store = new BillingStore();
const clock = { now: () => new Date() };
const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

const deps: HttpDeps = {
  store,
  plans: new PlanCatalog(DEMO_PLANS),
  // The demo provider accepts every charge.
  payments: { charge: async ({ idempotencyKey }) => ok({ chargeId: `ch_${idempotencyKey}` }) },
  webhooks: new WebhookPublisher({
    store,
    clock,
    log,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    transport: {
      post: async (url, headers, body) => (await fetch(url, { method: "POST", headers, body })).status,
    },
  }),
  clock,
  newId: () => crypto.randomUUID(),
  taxRateBasisPoints: 825,
  log,
  tokens: new Map<string, Caller>([
    ["demo-alice", { kind: "customer", customerId: "cus_alice" }],
    ["demo-admin", { kind: "admin", adminId: "adm_ops" }],
  ]),
};

setInterval(() => {
  const at = clock.now();
  renewDue(deps, at)
    .then(() => runDunning(deps, at))
    .catch((error: unknown) => log("billing_run_failed", { error: String(error) }));
}, 60_000);

createBillingServer(deps).listen(3000, () => log("listening", { port: 3000 }));
