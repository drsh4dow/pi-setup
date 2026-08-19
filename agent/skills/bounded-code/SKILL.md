---
name: bounded-code
description: Use for production loops, retries, resources, concurrency, or failures.
user-invokable: false
---

Production code is bounded when a reader can point to the limit on repeated work and resource growth, the owner of mutable state, and the handling for each failure.

## Rules

Apply every rule the change touches.

1. **Keep control flow visible.** Prefer direct calls, ordinary branches, and explicit state machines. Keep reflection, dynamic imports, metaclasses, and decorators at framework boundaries. Bound recursion by construction or with a guard. Use exceptions for failures, not routine branches.

2. **Bound repeated work.** Every loop stops by input size, count, deadline, or shutdown signal. Iteration over a collection counts only when construction or input validation limits its size. Retries need a maximum attempt count and backoff. Polling needs a deadline. Service loops need a shutdown path.

3. **Bound resource growth.** Put visible caps on queues, caches, buffers, connections, cursors, subprocesses, tasks, threads, and fanout. Producers need backpressure, caches need eviction, and spawns need a concurrency limit. When one request creates more work, state the maximum multiplier.

4. **Make failure handling explicit.** Use side-effect-free assertions only for impossible states. Send expected failures through the language's normal explicit channel, such as typed errors, `Result`, checked errors, or explicit exceptions. At each fallible call, handle the failure, propagate it, or convert it. Await promises or mark intentional detachment with a reason. Narrow optionals and inspect failure-signaling return values.

5. **Keep ownership obvious.** Give data the narrowest useful scope and shortest useful lifetime. Default to immutable bindings and private visibility. Shared mutable state needs one named owner and one synchronization strategy. Mutate inputs only when the contract permits it. Keep `unsafe` and interior-mutability escape hatches out of core logic.

6. **Keep configured checks clean.** Run the repository's strict formatter, type, lint, and static-analysis checks. Rewrite confusing code until they pass without new warnings. Put the reason beside any necessary suppression.

The pass is complete when every changed loop, retry, queue, cache, buffer, spawn, and shared state has a visible bound or owner, and every fallible operation has visible handling.

If a system constraint prevents one of these rules, put the bound or reason beside the code in a type, guard, or constraint comment. Fix related violations in code already touched instead of extending them. If the requested behavior truly requires an unbounded design, explain the cost and recommend the bounded alternative before implementation.
