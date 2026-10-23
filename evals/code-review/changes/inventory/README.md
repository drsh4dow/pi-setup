# inventory

Stock levels for the warehouse, behind a small JSON API. Standard library
only; the data lives in one SQLite file.

## Run

    INVENTORY_KEYS=ck_live:clerk,vk_live:viewer python3 -m inventory.server

| Variable         | Default        | Meaning                                  |
| ---------------- | -------------- | ---------------------------------------- |
| `INVENTORY_DB`   | `inventory.db` | SQLite file                              |
| `INVENTORY_KEYS` | none           | `KEY:role` pairs, comma separated        |
| `PORT`           | `8080`         | Port to listen on, bound to 127.0.0.1    |

## Auth

Every request sends its key in `X-Api-Key`. A `viewer` key may read. A
`clerk` key may also write. An unknown key gets 401; a viewer that tries to
write gets 403.

## Endpoints

| Method | Path                       | Role   | Body                                  |
| ------ | -------------------------- | ------ | ------------------------------------- |
| GET    | `/items`                   | viewer |                                       |
| GET    | `/items/{sku}`             | viewer |                                       |
| POST   | `/items`                   | clerk  | `{"sku", "name", "unit_cost_cents"}`  |
| POST   | `/items/{sku}/receive`     | clerk  | `{"quantity"}`                        |
| POST   | `/items/{sku}/ship`        | clerk  | `{"quantity"}`                        |
| POST   | `/items/{sku}/discontinue` | clerk  |                                       |
| PUT    | `/items/{sku}/reorder-point` | clerk | `{"point"}`                         |
| GET    | `/reorder`                 | viewer |                                       |

SKUs are upper-case letters, digits, and dashes, such as `BOLT-10`. Shipping
more than is on hand is a 409. A discontinued item keeps its stock and can
still ship, but can no longer be received.

Item responses carry money as integer cents (`unit_cost_cents`) and as text
(`unit_cost`, such as `"0.35"`).

## Reordering

In today's fast-paced warehouse, running out of stock isn't just an
inconvenience, it's a lost sale. The reorder report leverages each item's
reorder point to seamlessly surface exactly what needs restocking — so you
can focus on what matters most. It's a robust, streamlined workflow that
empowers clerks to stay ahead of demand — every single day.

Set a reorder point with `PUT /items/{sku}/reorder-point` and a body like
`{"point": 10}`. The point must be a positive integer.

`GET /reorder` lists every active item whose quantity is at or below its
reorder point, largest shortfall (`reorder_point - quantity`) first. Each line
suggests an `order_quantity` that brings stock up to twice the reorder point,
and its `order_cost_cents`. The response also carries `total_cents` and
`total`, the cost of the whole order as text.

## Test

    python3 -m unittest
