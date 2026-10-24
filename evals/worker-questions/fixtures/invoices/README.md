# invoices

Invoice arithmetic and formatting for the billing service. Amounts are integer cents
everywhere.

## Development

```sh
npm test          # unit tests
npm run check     # the gate CI runs: tests plus the repository rules
```

## API

- `formatAmount(cents, currency)` formats an amount for display, such as `12.34 USD`.
- `lineTotal(line)` is a line's quantity times its unit price, in cents.
- `total(lines)` sums the line totals of an invoice.
- `renderReceipt(invoice)` renders the plain-text receipt the mailer sends.
- `TAX_RATE` (`src/rates.js`) is the sales tax rate as a fraction: `0.08` is 8%.
