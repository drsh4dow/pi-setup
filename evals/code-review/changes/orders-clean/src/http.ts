import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authenticate, canAccess, type Caller } from "./auth.ts";
import { parseNewOrder, parsePayment, parseRefund } from "./input.ts";
import type { Cents } from "./money.ts";
import { cancelOrder, markPaid, markShipped, placeOrder, priceLines, type Order, type TransitionError } from "./orders.ts";
import { refundOrder, type RefundError } from "./refunds.ts";
import { err, ok, type Result } from "./result.ts";
import type { OrderStore } from "./store.ts";

export type Clock = { now(): Date };

export type Deps = {
  store: OrderStore;
  tokens: ReadonlyMap<string, Caller>;
  catalog: ReadonlyMap<string, Cents>;
  clock: Clock;
  newId(): string;
  logError(error: unknown): void;
};

type Reply = { status: number; body: unknown };

type Context = { deps: Deps; caller: Caller; id: string; body: unknown };

type Route = { method: string; path: RegExp; handle(context: Context): Reply };

const routes: Route[] = [
  { method: "POST", path: /^\/orders$/, handle: createOrder },
  { method: "GET", path: /^\/orders\/([^/]+)$/, handle: getOrder },
  { method: "POST", path: /^\/orders\/([^/]+)\/payment$/, handle: payOrder },
  { method: "POST", path: /^\/orders\/([^/]+)\/ship$/, handle: shipOrder },
  { method: "POST", path: /^\/orders\/([^/]+)\/cancel$/, handle: cancel },
  { method: "POST", path: /^\/orders\/([^/]+)\/refunds$/, handle: refund },
  { method: "GET", path: /^\/orders\/([^/]+)\/refunds$/, handle: listRefunds },
];

const REFUND_ERROR_STATUS: Record<RefundError["kind"], number> = { not_refundable: 409, exceeds_balance: 422 };

/** Returns an HTTP server for the orders API. The caller starts and stops it. */
export function createOrdersServer(deps: Deps): Server {
  return createServer((req, res) => {
    route(deps, req)
      .then((reply) => send(res, reply))
      .catch((error: unknown) => {
        deps.logError(error);
        send(res, { status: 500, body: { kind: "internal_error" } });
      });
  });
}

async function route(deps: Deps, req: IncomingMessage): Promise<Reply> {
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

function createOrder({ deps, caller, body }: Context): Reply {
  if (caller.kind !== "customer") return forbidden();
  const input = parseNewOrder(body);
  if (!input.ok) return { status: 400, body: input.error };
  const lines = priceLines(input.value.lines, deps.catalog);
  if (!lines.ok) return { status: 422, body: lines.error };
  const order = placeOrder({ id: deps.newId(), customerId: caller.customerId, lines: lines.value, at: deps.clock.now() });
  deps.store.save(order);
  return { status: 201, body: order };
}

function getOrder({ deps, caller, id }: Context): Reply {
  const order = findAccessible(deps, caller, id);
  if (!order.ok) return order.error;
  return { status: 200, body: order.value };
}

function payOrder({ deps, caller, id, body }: Context): Reply {
  const order = findAccessible(deps, caller, id);
  if (!order.ok) return order.error;
  const input = parsePayment(body);
  if (!input.ok) return { status: 400, body: input.error };
  return saveTransition(deps, markPaid(order.value, { paymentRef: input.value.paymentRef, at: deps.clock.now() }));
}

function shipOrder({ deps, caller, id }: Context): Reply {
  if (caller.kind !== "staff") return forbidden();
  const order = findAccessible(deps, caller, id);
  if (!order.ok) return order.error;
  return saveTransition(deps, markShipped(order.value, { at: deps.clock.now() }));
}

function cancel({ deps, caller, id }: Context): Reply {
  const order = findAccessible(deps, caller, id);
  if (!order.ok) return order.error;
  return saveTransition(deps, cancelOrder(order.value, { at: deps.clock.now() }));
}

function refund({ deps, caller, id, body }: Context): Reply {
  if (caller.kind !== "staff") return forbidden();
  const order = findAccessible(deps, caller, id);
  if (!order.ok) return order.error;
  const input = parseRefund(body);
  if (!input.ok) return { status: 400, body: input.error };
  const result = refundOrder(order.value, { id: deps.newId(), ...input.value, at: deps.clock.now() });
  if (!result.ok) return { status: REFUND_ERROR_STATUS[result.error.kind], body: result.error };
  deps.store.save(result.value);
  return { status: 201, body: result.value };
}

function listRefunds({ deps, caller, id }: Context): Reply {
  const order = findAccessible(deps, caller, id);
  if (!order.ok) return order.error;
  return { status: 200, body: order.value.refunds.toReversed() };
}

// Unknown orders and other customers' orders both answer 404, so ids can't be probed.
function findAccessible(deps: Deps, caller: Caller, id: string): Result<Order, Reply> {
  const order = deps.store.get(id);
  if (!order || !canAccess(caller, order)) return err({ status: 404, body: { kind: "order_not_found" } });
  return ok(order);
}

function saveTransition(deps: Deps, result: Result<Order, TransitionError>): Reply {
  if (!result.ok) return { status: 409, body: result.error };
  deps.store.save(result.value);
  return { status: 200, body: result.value };
}

function forbidden(): Reply {
  return { status: 403, body: { kind: "forbidden" } };
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
