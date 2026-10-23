# billing

Subscription billing for the product: customers subscribe to a plan, the service invoices
each billing period and charges the card on file, and integrations hear about it through
signed webhooks. Runs on Node 26 (TypeScript via type stripping) with no dependencies.
State lives in memory.

    npm start     # http://localhost:3000, demo plans and tokens from src/main.ts
    npm test

A timer in `src/main.ts` runs renewals (`renewDue` in `src/billing.ts`) and then dunning
(`runDunning` in `src/dunning.ts`) once a minute.

## Terms

- **Plan**: what a customer buys, with a price per period and an interval, `month` or
  `year`. An **archived** plan takes no new subscriptions; subscriptions already on it keep
  renewing at its price.
- **Billing period**: the span a subscription is invoiced for, from `currentPeriodStart` up
  to, but not including, `currentPeriodEnd`. Periods start on the subscription's **anchor
  day**; see `addIntervals` in `src/periods.ts` for months shorter than the anchor.
- **Trial**: a plan with `trialDays` starts its subscriptions `trialing`, with the trial as
  the first period. Trials are free: nothing is invoiced until the trial ends.
- **Renewal**: moving a subscription into its next period and invoicing that period in
  advance.
- **Invoice statuses**: a **draft** is being assembled and has no number. **Finalizing** a
  draft numbers it and makes it **open**: frozen and owed. An open invoice becomes **paid**
  when its charge succeeds, or **void** when dunning gives up on it. Only finalized invoices
  reach customers or webhooks. See `docs/adr-001-invoice-numbers.md`.
- **Past due**: a subscription whose latest charge failed. Dunning retries its open invoices
  and cancels it after the grace period; see `docs/dunning.md`.

## API

Every request needs `Authorization: Bearer <token>`. A token belongs to a customer or to an
admin. Customers see only their own subscriptions; one they can't access answers 404, the
same as an unknown id. Amounts are integer cents; times are ISO 8601 in UTC.

| Request | Who | Body | Success |
| --- | --- | --- | --- |
| `GET /plans` | anyone | | 200, the plans open for signup |
| `POST /subscriptions` | customer | `{ "planId": "pro" }` | 201, `{ subscription, invoice }` |
| `GET /subscriptions/:id` | owner, admin | | 200, the subscription |
| `PATCH /subscriptions/:id` | owner, admin | `{ "cancelAtPeriodEnd": true }` | 200, the subscription |
| `POST /subscriptions/:id/plan` | owner, admin | `{ "planId": "business" }` | 200, `{ subscription, invoice }` |
| `GET /subscriptions/:id/invoices` | owner, admin | | 200, its invoices, newest first |
| `POST /webhook-endpoints` | admin | `{ "url": "https://...", "events": ["invoice.paid"] }` | 201, the endpoint and its `secret` |
| `GET /webhook-endpoints` | admin | | 200, the endpoints, without secrets |
| `DELETE /webhook-endpoints/:id` | admin | | 200 |

A new subscription on a plan without a trial is invoiced for its first period right away,
and `invoice` is that invoice; a trialing one answers `"invoice": null`. A failed first
charge still creates the subscription, `past_due`. Subscription request bodies take only the
fields above; any other field answers 400 `invalid_input` naming it.

Errors answer a JSON body whose `kind` names the error: 401 `unauthenticated`, 403
`forbidden`, 404 `subscription_not_found` or `endpoint_not_found`, 400 `invalid_json` or
`invalid_input` with a `message`, 409 `subscription_canceled`, and 422 `unknown_plan` with
the `planId`. Plan changes add 409 `same_plan` and `not_changeable` (with the subscription's
`status`), and 422 `interval_mismatch` (with the `from` and `to` intervals).

## Plan changes

`POST /subscriptions/:id/plan` moves a trialing or active subscription to another plan open
for signup, on the same interval.

- An **upgrade**, to a more expensive plan, takes effect at once. The subscription is
  invoiced right away for the rest of the current period: a credit for the unused days on
  the old plan, then a charge for the same days on the new one, each prorated by remaining
  days over the days in the period. The day of the change counts as remaining. The
  response's `invoice` is that invoice, with `billingReason: "plan_change"`.
- A **downgrade**, to any other plan, waits for the next renewal. Until then the
  subscription keeps its plan and shows the new one as `scheduledPlanId`; the response's
  `invoice` is null. A later plan change replaces a scheduled downgrade.

Plan changes are safe to retry and need no reconciliation: the switch, the proration
invoice, and its charge are applied together, so a subscription never ends up on a plan it
hasn't paid for, and integrations receive each resulting event exactly once.

## Webhooks

`docs/webhooks.md` describes the envelope, the signature, delivery, and payload versions.
