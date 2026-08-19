---
name: codebase-design
description: Use for deep-module and interface design.
disable-model-invocation: false
user-invokable: false
---

# Codebase Design

Design **deep modules**: a lot of behaviour behind a small interface, placed at a clean seam, testable through that interface. Use this language and these principles wherever code is being designed or restructured. The aim is leverage for callers, locality for maintainers, and testability for everyone.

## Glossary

Use these terms exactly — don't substitute "component," "service," "API," or "boundary." Consistent language is the whole point.

**Module** — anything with an interface and an implementation. Deliberately scale-agnostic: a function, class, package, or tier-spanning slice. _Avoid_: unit, component, service.

**Interface** — everything a caller must know to use the module correctly: the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics. _Avoid_: API, signature (too narrow — they refer only to the type-level surface).

**Implementation** — what's inside a module, its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth** — leverage at the interface: the amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface, **shallow** when the interface is nearly as complex as the implementation.

**Seam** _(Michael Feathers)_ — a place where you can alter behaviour without editing in that place; the *location* at which a module's interface lives. Where to put the seam is its own design decision, distinct from what goes behind it. _Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter** — a concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside).

**Leverage** — what callers get from depth: more capability per unit of interface they learn. One implementation pays back across N call sites and M tests.

**Locality** — what maintainers get from depth: change, bugs, knowledge, and verification concentrate in one place rather than spreading across callers. Fix once, fixed everywhere.

## Deep vs shallow

**Deep module** = small interface + lots of implementation:

```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│                     │
│  Deep Implementation│  ← Complex logic hidden
│                     │
└─────────────────────┘
```

**Shallow module** = large interface + little implementation (avoid):

```
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through
└─────────────────────────────────┘
```

When designing an interface, ask:

- Can I reduce the number of methods?
- Can I simplify the parameters?
- Can I hide more complexity inside?

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, mockable, swappable parts. They just aren't part of the interface. A module can have **internal seams** private to its implementation and the **external seam** at its interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Introduce a seam when something actually varies across it.

## Shape the domain before the logic

Start with the data shape when it can remove downstream coordination. Identify the states the module may represent, the states it must reject, and the dominant reads and writes. Then choose the simplest structure that makes those facts visible:

- a state machine or discriminated union for exclusive lifecycle states
- a typed object for invariants now repeated across loose parameters
- a map, table, registry, index, tree, graph, queue, cache, or normalized collection when its access pattern calls for one
- a reducer or command/event model when ad hoc mutations obscure legal transitions
- one module organized around a body of domain knowledge rather than phase-named modules such as load, validate, transform, and save

The warning signs are booleans that must stay synchronized, another branch added to a chain spread across files, repeated shape assumptions, or the same invariant enforced by several callers. A better structure should delete branches, duplicated rules, invalid states, or lifecycle risk. If it only adds types, wrappers, or indirection, keep the boring local code.

Data-structure-first is a design probe, not a demand for setup work. Define core types early only when their shape constrains the implementation. Trace actual access patterns before choosing a collection. Similar statements can remain explicit. Add shared infrastructure only when the current task proves that later work depends on it. For shared mutable state, ask what another actor can change concurrently; isolate ownership when the answer affects correctness.

## Test reader load

Maintainability has two independent costs:

1. **Layers to trace.** Count the hops between a question and its answer. Collapse one-caller wrappers, pass-through adapters, and adjacent layers that repeat the same methods and arguments. Each retained layer should change the abstraction or hide meaningful decisions.
2. **State to hold.** Count the mutable or implicit facts a reader must remember. Keep state in the narrowest useful scope, derive values instead of synchronizing copies, and put each invariant at the interface that owns it.

Use concrete questions against the proposed module: "Where does this value come from?", "What can change it?", and "Where is this invariant enforced?" A reader should answer from the interface and one cohesive implementation path. Do not flatten a module merely to reduce hops if its interface compresses real complexity. Before adding a layer or state, verify that it removes at least as much reader load elsewhere.

## Designing for testability

Good interfaces make testing natural:

1. **Accept dependencies, don't create them.**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway();
   }
   ```

2. **Return results, don't produce side effects.**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount;
   }
   ```

3. **Small surface area.** Fewer methods = fewer tests needed. Fewer params = simpler test setup.

## Relationships

- A **Module** has exactly one **Interface** (the surface it presents to callers and tests).
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.

## Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods**: too narrow — interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD's bounded context. Say **seam** or **interface**.

## Going deeper

- **Deepening a cluster given its dependencies** — see [DEEPENING.md](DEEPENING.md): dependency categories, seam discipline, and replace-don't-layer testing.
- **Exploring alternative interfaces** — see [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md): spin up parallel sub-agents to design the interface several radically different ways, then compare on depth, locality, and seam placement.
