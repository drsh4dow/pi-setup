# report-service

Renders the weekly account reports from the Markdown templates in `templates/`.

```sh
node render.js <accounts.json> <out-dir>
```

Each render reads every template in `templates/` fresh, so a batch picks up template
changes between runs.
