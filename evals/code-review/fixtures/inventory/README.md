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

SKUs are upper-case letters, digits, and dashes, such as `BOLT-10`. Shipping
more than is on hand is a 409. A discontinued item keeps its stock and can
still ship, but can no longer be received.

Item responses carry money as integer cents (`unit_cost_cents`) and as text
(`unit_cost`, such as `"0.35"`).

## Test

    python3 -m unittest
