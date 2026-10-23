# Store design

## One lock, one map

`Store` keeps every job in `jobs`, keyed by ID, behind one mutex. Jobs are
small and the admin API is the only reader that scans, so one lock keeps
every operation atomic without making anything slow.

Every change goes through `commit`: build the next version of the job,
append it to the journal, and only then replace the stored job. A failed
append leaves memory as it was.

## Ready heaps

Each queue has a heap of its pending jobs, ordered by `runAt` and then by
enqueue order (`seq`). `Lease` looks only at the top of its queue's heap: if
the top job isn't due, nothing on the queue is.

The heap holds exactly the queue's pending jobs. `commit` pushes a job when
it enters `pending`, and `Lease`, the only way out of `pending`, pops it.
`Lease` relies on this and leases the top job without checking its state.
`Open` rebuilds the heaps from the replayed jobs.

## Leases and tokens

`leased` is the one check every worker operation passes through: the job is
`leased`, the token is its current one, and the lease hasn't expired by the
store's clock. The reaper only tidies up; correctness never waits for it. See
[ADR 001](adr/001-at-least-once-leases.md).

## Time

Every time the store records or compares comes from its `Clock`, so tests
run the whole lifecycle under a fake one. The worker pool's heartbeat and
polling tickers run on real time; they only decide when to ask the store.
