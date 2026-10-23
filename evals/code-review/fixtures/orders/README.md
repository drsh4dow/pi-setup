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

Order status moves `placed` -> `paid` -> `shipped`, or `placed` -> `cancelled`. A
transition out of that sequence answers 409.

Errors answer a JSON body whose `kind` names the error, plus its details: 401
`unauthenticated`, 403 `forbidden`, 404 `order_not_found`, 400 `invalid_json` or
`invalid_input` with a `message`, 409 `invalid_transition` with `from` and `to`, and 422
`unknown_sku` with the `sku`.

Tax is 8.25% of the subtotal, rounded to the nearest cent.
