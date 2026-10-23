import { isEventType, type EventType } from "./events.ts";
import type { PlanId } from "./plans.ts";
import { err, ok, type Result } from "./result.ts";
import type { SubscriptionUpdate } from "./subscriptions.ts";

export type InputError = { kind: "invalid_input"; message: string };

/** Parses the body of `POST /subscriptions`. Fails with a message naming the first bad field. */
export function parseNewSubscription(body: unknown): Result<{ planId: PlanId }, InputError> {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  if (typeof body.planId !== "string" || body.planId.trim() === "") return invalid("planId must be a non-empty string");
  return ok({ planId: body.planId });
}

/** Parses the body of `PATCH /subscriptions/:id`; fields it leaves out stay as they are. */
export function parseSubscriptionUpdate(body: unknown): Result<SubscriptionUpdate, InputError> {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  const update: SubscriptionUpdate = {};
  if ("cancelAtPeriodEnd" in body) {
    if (typeof body.cancelAtPeriodEnd !== "boolean") return invalid("cancelAtPeriodEnd must be a boolean");
    update.cancelAtPeriodEnd = body.cancelAtPeriodEnd;
  }
  return ok(update);
}

/** Parses the body of `POST /webhook-endpoints`: an https `url` and at least one event type. */
export function parseNewEndpoint(body: unknown): Result<{ url: string; events: EventType[] }, InputError> {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  if (typeof body.url !== "string" || !URL.canParse(body.url) || new URL(body.url).protocol !== "https:") {
    return invalid("url must be an https URL");
  }
  if (!Array.isArray(body.events) || body.events.length === 0) return invalid("events must be a non-empty array");

  const events: EventType[] = [];
  for (const event of body.events) {
    if (!isEventType(event)) return invalid(`unknown event type ${JSON.stringify(event)}`);
    events.push(event);
  }
  return ok({ url: body.url, events });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Result<never, InputError> {
  return err({ kind: "invalid_input", message });
}
