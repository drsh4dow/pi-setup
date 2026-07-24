---
name: bounded-code
description: Runtime discipline for production code. Use when writing or editing code that will run in production, when a change introduces a loop, retry, queue, cache, buffer, spawn, or concurrent access, or when reviewing code for runtime robustness.
---

Production code is **bounded**: every loop, allocation, retry, and lifetime has a limit a reader can point at, and every failure path is visible in source. The lineage is NASA/JPL's Power of Ten - rules built so that code can be verified by analysis rather than trusted by intent. This skill owns runtime discipline only; `seam-mapping` chooses the design, `abstraction-economics` prices the names, `beauty-gate` audits the diff.

## Rules

Flat reference - apply every rule the change touches. Criterion: every loop, retry, queue, cache, buffer, spawn, and shared state in the change names its bound or its owner; every fallible operation names its handling.

1. **Explicit control flow.** Behavior reads top-down in source: direct calls, boring branches, explicit state machines. Recursion carries a depth bound enforced by construction or a guard. Dispatch is visible - reflection, dynamic imports, metaclasses, and decorators stay at framework boundaries, out of core logic. Exceptions signal failure; normal flow uses returns.

2. **Bounded loops.** Every loop names its finite bound. Collection iteration counts when the collection size is bounded by construction or validated at entry. Retries carry max attempts with backoff; polling carries a deadline; service loops carry a shutdown path. A reviewer can point at the line where each loop ends.

3. **Bounded resources.** Growth is capped and the cap is visible: queues, caches, buffers, connections, cursors, subprocesses, tasks, threads, fanout. Producers meet backpressure, caches meet eviction, spawns meet a limit. Work amplification (one request spawning N) states its N.

4. **Assertions for impossible states, typed handling for expected failure.** Assertions are side-effect-free and guard invariants only. Expected failures travel through the language's explicit channel: typed errors or boundary throws in TypeScript, `Result`/`Option` in Rust, checked `error` in Go, explicit exceptions in Python.

5. **Every fallible operation is handled.** Handled immediately, propagated, or converted to a typed failure - at the call site. Go errors checked, Rust `Result`s consumed, promises awaited or explicitly detached with a reason, optionals narrowed, failure-signaling return values read.

6. **Smallest scope, least mutability, obvious ownership.** Data lives at the narrowest useful scope with the shortest useful lifetime; bindings default immutable, visibility defaults private. Shared mutable state has one named owner and one synchronization story; inputs are mutated only when the contract says so. `unsafe` and interior-mutability escape hatches stay out of core logic.

7. **Zero warnings.** The strictest available toolchain runs clean: TypeScript `strict` + Biome, Rust `cargo fmt` + `clippy -D warnings`, Go `gofmt` + `go vet` + `staticcheck`, Python `ruff` + `pyright`. Confusing code gets rewritten until the tools are quiet - suppressions carry a reason at the site.

## Bending a rule

A rule bends only with the bound or reason named where the violation lives - a comment, type, or guard a reviewer finds at the site. An unstated violation is a blocker: fix it before building on it, and fix related violations in touched code rather than extending them. When a request requires an unbounded design, surface the tradeoff and recommend the bounded alternative - the user decides with the cost visible.

## Not owned here

Function size, wrappers, constants, and configuration options - `abstraction-economics`. Design selection and blast radius - `seam-mapping`. Post-implementation audit - `beauty-gate`.
