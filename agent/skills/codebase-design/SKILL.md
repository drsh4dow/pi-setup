---
name: codebase-design
description: Simplify module responsibilities and interfaces when designing or restructuring code.
---

# Codebase design

Choose the design that is simplest for callers and maintainers. Start with deletions: redundant paths, repeated decisions, mutable copies, and layers that hide little work.

## Depth and locality

A module combines an interface with an implementation. Its interface includes everything callers must know: types, ordering, invariants, configuration, errors, and relevant performance constraints.

A deep module hides substantial complexity behind a small interface. Depth concerns how much callers must learn, not the number of implementation lines. Locality means knowledge and changes concentrate with their owner instead of spreading across callers.

Apply the deletion test: if removing a module removes complexity, it may be redundant. If the complexity reappears across callers, the module is earning its place.

## Reader load

Consider both the layers a reader must trace and the hidden state they must hold in mind.

- Collapse pass-through layers and duplicated decisions. Each remaining layer should change the abstraction or enforce a meaningful contract.
- Prefer locals and explicit data flow to broad mutable state. Derive values rather than synchronizing copies.
- Keep domain knowledge with its owner. Let callers use domain concepts without learning private transport, storage, or framework representations.
- Keep framework wiring mechanical. Separate computation from effects when that makes the code easier to understand; avoid extracting trivial functions merely for purity.
- Preserve cohesive functions and modules. File size and adapter counts are signals to inspect, not design rules.

When a requirement makes the existing design awkward, ask whether treating it as foundational would simplify the affected code. Redesign only where the result earns the migration cost.

## Testability

A seam is a place where behavior can be substituted; an adapter supplies an implementation there. Ownership, information hiding, and real variation can each justify a boundary.

Add a testing seam when meaningful behavior needs protection. Prefer existing interfaces and dependencies that are already substitutable. Avoid restructuring obvious code merely to make it testable.

## Conditional references

- When consolidating modules with different dependency types, read [DEEPENING.md](DEEPENING.md).
- When comparing alternative interfaces would resolve a consequential design choice, read [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md).
