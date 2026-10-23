# ratelimit

Per-client rate limiting for HTTP services, with token buckets. Standard
library only.

Each key (by default the client IP) gets a bucket that holds up to `Burst`
tokens and refills at `Rate` tokens per second. A request takes one token; a
request that finds the bucket empty gets `429 Too Many Requests` with a
`Retry-After` header in whole seconds.

## Use

```go
limiter, err := ratelimit.New(ratelimit.Config{Rate: 5, Burst: 10})
if err != nil {
	return err
}
handler := ratelimit.Middleware(limiter, ratelimit.ClientIP, app)
```

Call `limiter.Sweep()` now and then to drop buckets that have refilled to
full. A full bucket behaves exactly like a missing one, so sweeping changes
memory use, never limits.

## ratelimitd

`cmd/ratelimitd` runs a demo server that answers `ok` behind the limiter:

    go run ./cmd/ratelimitd -addr :8080 -rate 5 -burst 10

It sweeps once a minute.

## Admin API

The admin API is a powerful, seamless way to take control of your rate
limits — giving operators not just visibility, but real-time control over
every bucket. Whether you're debugging a noisy client or unblocking a
frustrated customer, it has you covered — no restarts, no hassle.

`NewAdmin(limiter, token)` returns an `http.Handler` to mount under
`/admin/`. Every request must send `Authorization: Bearer <token>`.

- `GET /admin/buckets/{key}` answers 200 with `{"key", "remaining", "burst", "as_of"}`, or 404.
- `DELETE /admin/buckets/{key}` refills the bucket to burst and answers 204, or 404.

Reading a bucket never changes it. `ratelimitd` mounts the admin API when
`-admin-token` or `RATELIMIT_ADMIN_TOKEN` is set.

## Test

    go test ./...
