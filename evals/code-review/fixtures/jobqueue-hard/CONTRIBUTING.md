# Contributing

Run `go vet ./...` and `go test -race ./...` before sending a change. No
third-party modules.

## Rules

1. **Journal format changes are versioned.** Anything that changes what a
   journal line can hold (a new `op`, a new `State`, a new field on `Job`)
   bumps `journalVersion` in `journal.go`, adds a row to the table in
   [docs/journal-format.md](docs/journal-format.md), and checks in
   `testdata/journal-v<previous>.jsonl`, written by the previous version, with
   a test that replays it. The format doc says why.
2. **Journal first, memory second.** A store method appends its record
   before it changes anything in memory, so a failed append leaves the store
   as it was. Store methods make changes through `commit`.
3. **Log events, not prose.** Log with `Logger.Event` and an event name from
   `events.go`. Never log a payload or a lease token.
4. **Errors name the job.** Store errors wrap their cause with `%w` and carry
   the job ID. Only `writeStoreError` turns store errors into HTTP responses.
