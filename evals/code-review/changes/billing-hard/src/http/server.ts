import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authenticate } from "../auth.ts";
import { err, ok, type Result } from "../result.ts";
import { createEndpoint, deleteEndpoint, listEndpoints } from "./endpoints.ts";
import { changeSubscriptionPlan } from "./plan-changes.ts";
import type { Context, HttpDeps, Reply } from "./replies.ts";
import { createSubscription, getSubscription, listInvoices, listPlans, updateSubscription } from "./subscriptions.ts";

type Route = { method: string; path: RegExp; handle(context: Context): Reply | Promise<Reply> };

const routes: Route[] = [
  { method: "GET", path: /^\/plans$/, handle: listPlans },
  { method: "POST", path: /^\/subscriptions$/, handle: createSubscription },
  { method: "GET", path: /^\/subscriptions\/([^/]+)$/, handle: getSubscription },
  { method: "PATCH", path: /^\/subscriptions\/([^/]+)$/, handle: updateSubscription },
  { method: "POST", path: /^\/subscriptions\/([^/]+)\/plan$/, handle: changeSubscriptionPlan },
  { method: "GET", path: /^\/subscriptions\/([^/]+)\/invoices$/, handle: listInvoices },
  { method: "POST", path: /^\/webhook-endpoints$/, handle: createEndpoint },
  { method: "GET", path: /^\/webhook-endpoints$/, handle: listEndpoints },
  { method: "DELETE", path: /^\/webhook-endpoints\/([^/]+)$/, handle: deleteEndpoint },
];

/** Returns an HTTP server for the billing API. The caller starts and stops it. */
export function createBillingServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    route(deps, req)
      .then((reply) => send(res, reply))
      .catch((error: unknown) => {
        deps.log("request_failed", { method: req.method, url: req.url, error: String(error) });
        send(res, { status: 500, body: { kind: "internal_error" } });
      });
  });
}

async function route(deps: HttpDeps, req: IncomingMessage): Promise<Reply> {
  const caller = authenticate(req.headers.authorization, deps.tokens);
  if (!caller) return { status: 401, body: { kind: "unauthenticated" } };

  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  for (const { method, path, handle } of routes) {
    const match = path.exec(pathname);
    if (!match || req.method !== method) continue;
    const body = await readJson(req);
    if (!body.ok) return { status: 400, body: { kind: "invalid_json" } };
    return handle({ deps, caller, id: match[1] ?? "", body: body.value });
  }
  return { status: 404, body: { kind: "not_found" } };
}

async function readJson(req: IncomingMessage): Promise<Result<unknown, "invalid_json">> {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (text === "") return ok(undefined);
  try {
    return ok(JSON.parse(text));
  } catch {
    return err("invalid_json");
  }
}

function send(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
}
