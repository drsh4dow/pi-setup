# Contributing

Run `python3 -m unittest` before sending a change. No third-party packages.

## Rules

1. **Money is integer cents.** Store, compute, and return money as `int`
   cents in names ending `_cents`. Never hold money in a `float`, and never
   divide cents by 100 to make dollars: turn cents into text only with
   `inventory.money.format_cents`.
2. **SQL uses placeholders.** Pass every value through `?` parameters. Never
   build SQL with f-strings, `%`, `.format`, or concatenation, even for values
   you believe are safe.
3. **Every public function and method has a docstring** that says what it
   returns and which `InventoryError` subclasses it raises. Names starting
   with `_` are exempt.

## Layers

`store.py` owns the data and its rules, such as positive quantities.
`api.py` checks the shape of request bodies, enforces roles, and maps
`InventoryError` subclasses to HTTP statuses. `server.py` only adapts
`http.server` to `Api.handle`.
