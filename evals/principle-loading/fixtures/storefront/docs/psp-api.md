# Paylane API (excerpt)

Base URL `https://api.paylane.example/v2`. Amounts are integers in the currency's minor unit.
Currencies: `usd`, `eur`, `gbp`.

## Objects

- **Customer**: `{ id: "cus_...", email, name, default_payment_method: "pm_..." | null }`
- **PaymentMethod**: `{ id: "pm_...", type: "card" | "sepa_debit", card?: { brand, last4, exp_month, exp_year }, sepa_debit?: { iban_last4 } }`
- **Charge**: `{ id: "ch_...", amount, currency, customer: "cus_...", payment_method: "pm_...", status: "pending" | "succeeded" | "failed", failure_code?: string, metadata: { [key: string]: string }, created: unix_seconds }`
- **Refund**: `{ id: "re_...", charge: "ch_...", amount, status: "pending" | "succeeded" | "failed", reason?: "duplicate" | "fraudulent" | "requested_by_customer" }`

## Endpoints

- `POST /customers`, `GET /customers/:id`
- `POST /customers/:id/payment_methods`
- `POST /charges` body `{ amount, currency, customer, payment_method, metadata }`
- `POST /refunds` body `{ charge, amount?, reason? }` (omit amount for a full refund)

## Webhooks

Paylane POSTs JSON events to your endpoint with header `Paylane-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>" with your webhook secret>`.

```json
{ "id": "evt_...", "type": "charge.succeeded", "created": 1761040000, "data": { "object": { "id": "ch_...", "amount": 2400, "currency": "usd", "metadata": { "order_id": "o_1" } } } }
```

Event types: `charge.succeeded`, `charge.failed`, `refund.succeeded`. Events can be delivered more than once and out of order.
