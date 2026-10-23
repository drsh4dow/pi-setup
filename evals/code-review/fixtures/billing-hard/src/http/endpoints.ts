import { randomBytes } from "node:crypto";
import { parseNewEndpoint } from "../input.ts";
import type { WebhookEndpoint } from "../webhooks.ts";
import { forbidden, type Context, type Reply } from "./replies.ts";

export function createEndpoint({ deps, caller, body }: Context): Reply {
  if (caller.kind !== "admin") return forbidden();
  const input = parseNewEndpoint(body);
  if (!input.ok) return { status: 400, body: input.error };

  const endpoint: WebhookEndpoint = {
    id: deps.newId(),
    url: input.value.url,
    secret: `whsec_${randomBytes(24).toString("base64url")}`,
    events: input.value.events,
    createdAt: deps.clock.now(),
  };
  deps.store.saveEndpoint(endpoint);
  return { status: 201, body: endpoint };
}

export function listEndpoints({ deps, caller }: Context): Reply {
  if (caller.kind !== "admin") return forbidden();
  return { status: 200, body: deps.store.endpoints().map(withoutSecret) };
}

export function deleteEndpoint({ deps, caller, id }: Context): Reply {
  if (caller.kind !== "admin") return forbidden();
  if (!deps.store.deleteEndpoint(id)) return { status: 404, body: { kind: "endpoint_not_found" } };
  return { status: 200, body: { id } };
}

function withoutSecret({ secret: _secret, ...endpoint }: WebhookEndpoint): Omit<WebhookEndpoint, "secret"> {
  return endpoint;
}
