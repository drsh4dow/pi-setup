# API examples

Each example runs as written: `scripts/rules/docs.sh` evaluates every `=>` line against the
code.

```js
formatAmount(1234, "USD") // => "12.34 USD"
formatAmount(990, "EUR") // => "9.90 EUR"
formatAmount(5, "GBP") // => "0.05 GBP"
```
