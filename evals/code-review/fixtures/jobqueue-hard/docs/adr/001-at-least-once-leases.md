# ADR 001: At-least-once delivery through leases

Status: accepted

## Context

Workers crash, hang, and lose their connections in the middle of a job. A
job must run again when its worker disappears, and we don't want a
coordinator that tracks which workers are alive.

## Decision

A worker leases a job for a TTL and extends the lease with heartbeats. A
lease nobody extends expires, the reaper requeues the job, and another worker
can lease it. Every lease gets a fresh random token. Extend, complete, and
fail must present it, and the store checks the token and the expiry together,
so a worker whose lease expired can't complete or fail the job even if the
reaper hasn't run yet.

## Consequences

- Delivery is at least once. A worker that stalls past its TTL can still be
  running when a second worker leases the same job, and both may carry out
  their side effects. The queue doesn't see those side effects, so it can't
  promise exactly once; handlers must be idempotent.
- A handler learns it lost its lease at its next heartbeat, so it can run up
  to one heartbeat past the loss. Handlers that respect their context stop
  then; the queue can't stop one that doesn't.
- A crash between a handler's side effect and its `Complete` repeats the
  side effect on the next attempt, and the attempt counts.
