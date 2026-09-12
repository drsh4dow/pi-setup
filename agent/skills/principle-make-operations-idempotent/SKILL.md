---
name: principle-make-operations-idempotent
description: Define retry behavior for commands and lifecycle operations that can restart after partial execution.
---

# Make operations idempotent

For retryable work, identify what happens if it runs twice or stops between state changes.

Choose the simplest contract that handles those cases: converging on desired state, deduplicating an operation, committing a transaction, or resuming recorded progress. Some effects cannot be repeated safely; model that constraint explicitly.

Reconcile partial state when it changes the next run's outcome. Keep ownership clear so cleanup removes only stale artifacts the operation owns. Avoid adding reconciliation machinery to mutations that are not retried.
