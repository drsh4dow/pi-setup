# tally

Unit conversions over HTTP.

## API

- `GET /health`: `{"ok": true}`.
- `GET /version`: `{"commit": "<sha>"}`, the commit the running build came from.

## Deploys

Every merge to `main` builds `dist/` with `npm run build` and serves it with `node dist/server.mjs`.
