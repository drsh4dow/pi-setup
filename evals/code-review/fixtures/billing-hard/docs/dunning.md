# Dunning

When a charge fails, the invoice stays `open` and its subscription goes `past_due`, with
`pastDueSince` set to the time of the failure. `runDunning` then runs on every billing tick:

1. It retries each open invoice of each past_due subscription.
2. A subscription with no open invoices left becomes `active` again.
3. A subscription that has been past due for 14 whole days (`GRACE_DAYS`), counted from
   `pastDueSince`, is canceled, and its open invoices are voided.

The grace period is a promise in the terms of service: a customer has the full 14 days,
to the hour, to fix their card. Support quotes the exact time a subscription will be
canceled from `pastDueSince`.
