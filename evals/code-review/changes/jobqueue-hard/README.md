# jobqueue

A persistent job queue for Go services. Jobs live in memory and in an
append-only journal on disk, workers lease them one at a time, failed
attempts come back after a backoff, and an HTTP admin API lets people look at
jobs, add them, cancel them, and retry dead ones.

Standard library only. `go test -race ./...` runs everything.

## Terms

- **Job**: a JSON payload on a named queue, plus everything the queue knows
  about it. A job enqueued without a queue goes on `default`.
- **Lease**: a worker's claim on a job for a fixed time. Each lease carries a
  fresh token, and the worker presents it to extend, complete, or fail the
  job. An expired lease is worthless even before the reaper notices it.
- **Attempt**: one lease of a job. `attempts` counts the leases handed out,
  including one in progress, and never goes past `maxAttempts`.
- **Requeue**: what follows a failed attempt, whether the worker failed the
  job or its lease expired. The job goes back to `pending` and waits out its
  backoff, and the attempt still counts. A job requeued after its last
  attempt goes `dead` instead.
- **Backoff**: how long a requeued job waits: `base * 2^(attempts-1)`, capped
  at `max`.

## Job lifecycle

| From      | To         | When                                 |
| --------- | ---------- | ------------------------------------ |
|           | `pending`  | enqueued                             |
| `pending` | `leased`   | a worker leases it after its `runAt` |
| `leased`  | `leased`   | the worker extends its lease         |
| `leased`  | `done`     | the worker completes it              |
| `leased`  | `pending`  | requeued with attempts left          |
| `leased`  | `dead`     | requeued after its last attempt      |
| `pending` | `canceled` | an operator cancels it               |
| `leased`  | `canceled` | an operator cancels it               |
| `dead`    | `pending`  | an operator retries it               |

Delivery is at least once; see
[ADR 001](docs/adr/001-at-least-once-leases.md). How the store keeps this
straight is in [docs/design.md](docs/design.md).

## Workers

```go
pool := jobqueue.NewPool(store, jobqueue.PoolConfig{Queue: "mail", Workers: 4, LeaseTTL: 30 * time.Second}, sendMail, logger)
pool.Start()
defer pool.Stop()
```

The handler's context is canceled when its lease is lost, its job is
canceled, or the pool stops.
A heartbeat extends the lease every `Heartbeat` (default `LeaseTTL / 3`). A
handler that returns an error fails the attempt, and so does one that panics.

## Admin API

Every request needs `Authorization: Bearer <token>`. `jobqueued -tokens`
maps tokens to roles:

- `viewer` lists and reads jobs, without their payloads.
- `operator` does everything a viewer does, sees payloads, enqueues,
  cancels, and retries.
- `auditor` does everything a viewer does and sees payloads, but changes
  nothing. It's for support staff working out why a job failed.

| Method and path            | Role       | Does                                                   |
| -------------------------- | ---------- | ------------------------------------------------------ |
| `GET /jobs`                | `viewer`   | lists jobs, filtered by `?queue=` and `?state=`        |
| `GET /jobs/{id}`           | `viewer`   | one job; operators and auditors also get its payload   |
| `POST /jobs`               | `operator` | enqueues `{queue, payload, maxAttempts, delaySeconds}` |
| `POST /jobs/{id}/cancel`   | `operator` | cancels a pending or leased job, `{reason}` optional   |
| `POST /jobs/{id}/retry`    | `operator` | retries a dead job, `{maxAttempts}` optional           |
| `GET /stats`               | `viewer`   | job counts by queue and state                          |

Errors answer `{"error": "<code>", ...}`: 400 `invalid`, 401 `unauthorized`,
403 `forbidden`, 404 `not_found`, and 409 `not_cancelable` or `not_dead`
with the job's current `state`.

## Canceling and retrying

A dead job used to need a fresh enqueue, which lost its history. Now an
operator retries it in place: it goes back to `pending`, due at once, with
its attempts back at zero. `{"maxAttempts": n}` gives it a new limit;
without it the job keeps the limit it had.

Canceling moves a `pending` or `leased` job to `canceled`, which is final.
A leased job's token stops working right away, and its handler's context is
canceled within one heartbeat.

Both operations are safe to call at any time, from any number of operators
at once. A canceled job never runs again and a retried job runs exactly
once, so an operator can act on what the admin API shows without checking
with the team that owns the workers first.

## Running

```bash
go run ./cmd/jobqueued -journal /var/lib/jobqueue/jobs.journal -addr 127.0.0.1:8090
```

Tokens come from `-tokens` or `JOBQUEUE_TOKENS`, as `token=role` pairs:
`JOBQUEUE_TOKENS='k7f2=operator,p9q1=viewer'`.
