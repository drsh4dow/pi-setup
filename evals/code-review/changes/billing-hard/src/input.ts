import { isEventType, type EventType } from "./events.ts";
import type { PlanId } from "./plans.ts";
import { err, ok, type Result } from "./result.ts";

export type InputError = { kind: "invalid_input"; message: string };

/** The fields a subscription request body may carry; each endpoint requires the ones it needs. */
export type SubscriptionFields = { planId?: PlanId; cancelAtPeriodEnd?: boolean };

const SUBSCRIPTION_FIELD_NAMES: readonly (keyof SubscriptionFields)[] = ["planId", "cancelAtPeriodEnd"];

/** Parses the body of `POST /subscriptions`. Fails with a message naming the first bad field. */
export function parseNewSubscription(body: unknown): Result<{ planId: PlanId }, InputError> {
  const fields = parseSubscriptionFields(body);
  if (!fields.ok) return fields;
  if (fields.value.planId === undefined) return invalid("planId is required");
  return ok({ planId: fields.value.planId });
}

/** Parses the body of `POST /subscriptions/:id/plan`, which names the plan the way a new subscription does. */
export function parsePlanChange(body: unknown): Result<{ planId: PlanId }, InputError> {
  return parseNewSubscription(body);
}

/** Parses the body of `PATCH /subscriptions/:id`; fields it leaves out stay as they are. */
export function parseSubscriptionUpdate(body: unknown): Result<SubscriptionFields, InputError> {
  return parseSubscriptionFields(body);
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

/**
 * Parses a subscription request body: a JSON object holding only subscription fields, each
 * well formed. Fails on the first unknown or malformed field.
 */
function parseSubscriptionFields(body: unknown): Result<SubscriptionFields, InputError> {
  if (!isRecord(body)) return invalid("body must be a JSON object");
  const unknownField = Object.keys(body).find((name) => !SUBSCRIPTION_FIELD_NAMES.some((known) => known === name));
  if (unknownField !== undefined) return invalid(`unknown field ${unknownField}`);

  const fields: SubscriptionFields = {};
  if ("planId" in body) {
    if (typeof body.planId !== "string" || body.planId.trim() === "") return invalid("planId must be a non-empty string");
    fields.planId = body.planId;
  }
  if ("cancelAtPeriodEnd" in body) {
    if (typeof body.cancelAtPeriodEnd !== "boolean") return invalid("cancelAtPeriodEnd must be a boolean");
    fields.cancelAtPeriodEnd = body.cancelAtPeriodEnd;
  }
  return ok(fields);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): Result<never, InputError> {
  return err({ kind: "invalid_input", message });
}
