import type { Invoice } from "./invoices.ts";
import { invoicePayload, subscriptionPayload } from "./payloads.ts";
import type { Subscription } from "./subscriptions.ts";

/** The current version of each payload shape. Every event carries the version of its `data`. */
export const PAYLOAD_VERSIONS = { subscription: 3, invoice: 1 } as const;

export const SUBSCRIPTION_EVENTS = ["subscription.created", "subscription.updated", "subscription.canceled"] as const;
export const INVOICE_EVENTS = ["invoice.finalized", "invoice.paid", "invoice.payment_failed"] as const;

export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENTS)[number];
export type InvoiceEventType = (typeof INVOICE_EVENTS)[number];
export type EventType = SubscriptionEventType | InvoiceEventType;

export const EVENT_TYPES: readonly EventType[] = [...SUBSCRIPTION_EVENTS, ...INVOICE_EVENTS];

/** The envelope every webhook delivers. See docs/webhooks.md. */
export type WebhookEvent = {
  id: string;
  type: EventType;
  version: number;
  createdAt: string;
  data: Record<string, unknown>;
};

/** Returns a subscription event describing `subscription` as it is at `at`. */
export function subscriptionEvent(input: {
  id: string;
  type: SubscriptionEventType;
  subscription: Subscription;
  at: Date;
}): WebhookEvent {
  return {
    id: input.id,
    type: input.type,
    version: PAYLOAD_VERSIONS.subscription,
    createdAt: input.at.toISOString(),
    data: subscriptionPayload(input.subscription),
  };
}

/** Returns an invoice event describing `invoice` as it is at `at`. */
export function invoiceEvent(input: { id: string; type: InvoiceEventType; invoice: Invoice; at: Date }): WebhookEvent {
  return {
    id: input.id,
    type: input.type,
    version: PAYLOAD_VERSIONS.invoice,
    createdAt: input.at.toISOString(),
    data: invoicePayload(input.invoice),
  };
}

/** Returns whether `value` names an event type. */
export function isEventType(value: unknown): value is EventType {
  return EVENT_TYPES.some((type) => type === value);
}
