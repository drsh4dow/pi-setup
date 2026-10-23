# Webhooks

An admin registers an endpoint with `POST /webhook-endpoints`, naming the event types it
wants. The response holds the endpoint's signing `secret`; it is never shown again.

## Envelope

Every delivery is a `POST` with a JSON body:

```json
{
  "id": "6f1c...",
  "type": "invoice.paid",
  "version": 1,
  "createdAt": "2026-03-01T00:00:00.000Z",
  "data": { "...": "the payload, see below" }
}
```

## Signature

The `billing-signature` header is `t=<unix seconds>,v1=<hex>`, where `<hex>` is the
HMAC-SHA256 of `<t>.<raw body>` under the endpoint secret. Receivers should recompute it,
compare in constant time, and reject a `t` more than five minutes old.

## Delivery

Delivery is at least once. Each endpoint gets up to three attempts per event, with a
backoff between them; any 2xx response ends the retries. An event can therefore arrive more
than once, for example when an endpoint answers after our timeout. Receivers deduplicate on
the envelope `id` (also sent as the `billing-event-id` header). Events are not ordered
across subscriptions, and a retried event can arrive after a later one.

## Events and payloads

| Event | Payload | When |
| --- | --- | --- |
| `subscription.created` | subscription | a customer subscribes |
| `subscription.updated` | subscription | a subscription renews, changes, falls behind, or recovers |
| `subscription.canceled` | subscription | a subscription ends |
| `invoice.finalized` | invoice | an invoice is numbered and owed |
| `invoice.paid` | invoice | an invoice's charge succeeds |
| `invoice.payment_failed` | invoice | an invoice's charge fails |

The **subscription** payload has `id`, `customerId`, `planId`, `status`,
`currentPeriodStart`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `scheduledPlanId` (the plan a
downgrade takes effect on at the next renewal, or null), and `canceledAt`.

The **invoice** payload has `id`, `number`, `customerId`, `subscriptionId`, `status`,
`billingReason` (`period` for signup and renewal invoices, `plan_change` for proration),
`lines` (each with `description`, `amountCents`, `periodStart`, `periodEnd`),
`subtotalCents`, `taxCents`, and `totalCents`.

## Versions

An event's `version` is the version of its payload shape, from `PAYLOAD_VERSIONS` in
`src/events.ts`. Any change to a payload's fields, even an added optional one, ships as a
new version, because some integrations validate payloads strictly and reject fields they
don't know. Integrations read the version first and pick their parser by it. Only the
current version is sent, so the changelog below is how integrators learn what changed
before they update their parsers.

## Changelog

Newest first.

- subscription v3: added `scheduledPlanId`.
- subscription v2: added `canceledAt`.
- subscription v1, invoice v1: first versions.
