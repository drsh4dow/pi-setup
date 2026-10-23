---
name: principle-engineering-standards
description: "Apply when writing, changing, or reviewing code."
disable-model-invocation: false
user-invokable: false
---

# Engineering standards

Correct behavior is necessary but not sufficient. Bad code is hard to read,
understand, and evolve. Changing one thing breaks something far away, a
feature means patching many places and still missing one, the design's
invariants are unclear, and tests need mocks that expose implementation
details. Hold each design decision to that standard, and read your final diff
against it before reporting.

**Contracts.** Validate data where it crosses a trust boundary and trust the
internal types, per **principle-boundary-discipline**. Leave out checks and
branches that re-establish what the types or preceding code already guarantee.
Use direct calls for known contracts, and confine
reflection and runtime structural inspection to code whose job is parsing or
dynamic integration.

Make the compiler reject impossible states, mismatched primitives, and
unhandled variants. Prefer defining errors and special cases out of existence
over proliferating handlers. For TypeScript syntax, see the
`typescript-best-practices` skill.

- **Brand semantic primitives.** `UserId` and `OrderId` are strings underneath
  but should not be interchangeable. Give each its own type, such as a branded
  intersection in TypeScript or a newtype elsewhere. Validate once at creation,
  trust the type downstream. If two arguments share a primitive type but mean
  different things, brand them.
- **Derive types from authoritative schemas.** When a protocol buffer, OpenAPI
  spec, GraphQL schema, database migration, design-token file, or another file
  owns a shape, derive from it instead of hand-rolling a parallel type. See the
  **encode-lessons-in-structure** principle skill.

**Dependencies.** Make dependencies explicit, construct them at the
application's assembly points, and pass them to consumers.

**Unchecked assumptions.** First seek a checked conversion or a better
contract. When an unchecked operation is necessary, keep it local and document
the specific invariant that makes it safe and where that invariant is
established.

**Failures.** Handle each fallible operation where it is called, in a scope
that covers only that operation, so the reader sees which call failed and what
follows. Decide there whether to recover, add context and propagate, or stop.
Represent expected failures as values in the form the language or stack owns,
such as Go's `error`, Rust's `Result`, or Effect's error channel, and branch on
them explicitly. When propagating, wrap the error with the operation and the
identifiers needed to find the affected data, keeping the original as its
cause. Where a failure stops propagating, by recovery or at a boundary, record
it once through the project's logging or tracing. Catch everything only at a
boundary that reports unhandled failures, such as a request handler or `main`.

**Cost.** Choose data structures and algorithms for the expected workload,
counting work hidden inside helpers, and avoid repeated scans or growing copies
that turn quadratic. Copy for ownership, snapshots, or mutation isolation;
otherwise reuse references. Bound buffers, caches, and concurrency when input
can grow. Leave speculative optimization out, and measure when costs are
uncertain and consequential.

**Readability.** Write beautiful, boring, explicit code for a tired, smart
maintainer. Beautiful, readable code is a completion requirement, so correct
output from ugly code is not done. Name things for their domain roles. Keep
control flow direct and shallow. More than three levels of logical nesting
means the design needs refactoring through guard clauses or a simpler state
model; moving nested code into arbitrary helpers does not count. Extract a
helper only when its name and contract let the caller read without opening it.
Group related statements and separate logical steps with a blank line, without
spacing every line apart. Give each branch and each conditional field its own
statement; nested ternaries and clever compressed expressions become ordinary
control flow. Keep an absent value distinct from an explicitly empty or null
one. Declare each constant in the narrowest scope that covers its uses.

**Tests.** Write the failing test first, then the fix. Write each test per
**principle-test-behavior-not-implementation**, which defines the tautological
tests that are forbidden.

**Verification.** Prove the change against the real artifact per
**principle-prove-it-works**, check each unit before the next per
**principle-sequence-verifiable-units**, and run the checks the repository
requires.
