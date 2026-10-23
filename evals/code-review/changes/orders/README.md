# orders

Order service for the shop: customers place and pay for orders, staff ship them. Runs on
Node 26 (TypeScript via type stripping) with no dependencies. Orders live in memory.

    npm start     # http://localhost:3000, demo catalog and tokens from src/main.ts
    npm test

## API

Every request needs `Authorization: Bearer <token>`. A token belongs to a customer or to a
staff member. Customers see only their own orders; an order they can't access answers 404,
the same as an unknown id. Amounts are integer cents.

| Request | Who | Body | Success |
| --- | --- | --- | --- |
| `POST /orders` | customer | `{ "lines": [{ "sku": "MUG-01", "quantity": 2 }] }` | 201, the order |
| `GET /orders/:id` | owner, staff | | 200, the order |
| `POST /orders/:id/payment` | owner, staff | `{ "paymentRef": "pi_123" }` | 200, the order |
| `POST /orders/:id/ship` | staff | | 200, the order |
| `POST /orders/:id/cancel` | owner, staff | | 200, the order |
| `POST /orders/:id/refunds` | staff | `{ "amountCents": 500, "reason": "late delivery" }` | 201, the order |
| `GET /orders/:id/refunds` | owner, staff | | 200, the refunds |

Order status moves `placed` -> `paid` -> `shipped`, or `placed` -> `cancelled`. A paid or
shipped order moves to `refunded` once its refunds add up to its total. A
transition out of that sequence answers 409.

Errors answer a JSON body whose `kind` names the error, plus its details: 401
`unauthenticated`, 403 `forbidden`, 404 `order_not_found`, 400 `invalid_json` or
`invalid_input` with a `message`, 409 `invalid_transition` with `from` and `to`, and 422
`unknown_sku` with the `sku`.

Tax is 8.25% of the subtotal, rounded to the nearest cent.

## Refunds

Refunds are a seamless way for staff to make things right with customers — whether an item
arrived damaged or an order came back. The refunds API leverages the existing order model, so
a refund isn't just money going back; it's a first-class part of the order's history.

Staff can refund an order in several parts — each refund is checked against what is left —
and each one records its `id`, `amountCents`, `reason`, and `createdAt`. A refund on an order
that isn't paid or shipped answers 409 `not_refundable` with its `status`; one that is too
large answers 422 `exceeds_balance` with the `remainingCents`. `GET /orders/:id/refunds`
lists an order's refunds, newest first.
