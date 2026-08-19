---
name: bounded-code
description: Use for production loops, retries, resources, concurrency, failures, or external input.
disable-model-invocation: false
user-invokable: false
---

Production code is bounded when a reader can point to the limit on repeated work and resource growth, the owner of mutable state, the handling for each failure, and how interrupted work converges when rerun.

## Rules

Apply every rule the change touches.

1. **Keep control flow visible.** Prefer direct calls, ordinary branches, and explicit state machines. Keep reflection, dynamic imports, metaclasses, and decorators at framework boundaries. Bound recursion by construction or with a guard. Use exceptions for failures, not routine branches.

2. **Bound repeated work.** Every loop stops by input size, count, deadline, or shutdown signal. Iteration over a collection counts only when construction or input validation limits its size. Retries need a maximum attempt count and backoff. Polling needs a deadline. Service loops need a shutdown path.

3. **Bound resource growth.** Put visible caps on queues, caches, buffers, connections, cursors, subprocesses, tasks, threads, and fanout. Producers need backpressure, caches need eviction, and spawns need a concurrency limit. When one request creates more work, state the maximum multiplier.

4. **Make failure handling explicit.** Use side-effect-free assertions only for impossible states. Send expected failures through the language's normal explicit channel, such as typed errors, `Result`, checked errors, or explicit exceptions. At each fallible call, handle the failure, propagate it, or convert it. Await promises or mark intentional detachment with a reason. Narrow optionals and inspect failure-signaling return values. Boundary validation does not erase failures that valid internal operations can produce.

5. **Make reruns converge.** Commands, lifecycle steps, and processing loops that may restart or retry must reconcile existing state rather than assume a clean start. Check the operation after two consecutive runs and after interruption at each state-changing step. Re-execution should reach the same intended end state. Detect and clean stale artifacts, adopt valid existing resources when ownership is clear, and compare cleanup targets by identity or content rather than creation order. Locks need an ownership record and a safe stale-owner test. Regenerate attempt-specific input when failed work is scheduled again. Do not label an operation idempotent if duplicate external effects remain possible; use a stable operation key, transactional boundary, or explicit reconciliation.

6. **Validate external input once.** Parse and narrow CLI arguments, config, network data, external API responses, and persisted wire formats where they enter the system. Convert them to internal domain types and avoid leaking transport, storage, or framework representations through internal interfaces. Inside that validated boundary, trust the resulting type instead of scattering the same guards through call chains. Revalidate only when data crosses another trust boundary or an internal invariant cannot be represented by the type. Keep adapter code focused on translation and lifecycle concerns. Prefer side-effect-free domain logic when it makes behavior easier to test, but do not fragment coherent code merely to extract pure functions.

7. **Keep ownership obvious.** Give data the narrowest useful scope and shortest useful lifetime. Default to immutable bindings and private visibility. Shared mutable state needs one named owner and one synchronization strategy. Mutate inputs only when the contract permits it. Keep `unsafe` and interior-mutability escape hatches out of core logic.

8. **Keep configured checks clean.** Run the repository's strict formatter, type, lint, and static-analysis checks. Rewrite confusing code until they pass without new warnings. Put the reason beside any necessary suppression.

The pass is complete when every changed loop, retry, queue, cache, buffer, spawn, and shared state has a visible bound or owner; every fallible operation has visible handling; interruptible mutations converge after rerun; and untrusted external data becomes a trusted internal type at one visible boundary.

If a system constraint prevents one of these rules, put the bound or reason beside the code in a type, guard, or constraint comment. Fix related violations in code already touched instead of extending them. If the requested behavior truly requires an unbounded or non-convergent design, explain the cost and recommend the bounded alternative before implementation.
