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

## Test

    go test ./...
