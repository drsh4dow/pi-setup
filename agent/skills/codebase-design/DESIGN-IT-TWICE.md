# Design it twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, design several alternatives before choosing one. Based on "Design It Twice" by Ousterhout: your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](SKILL.md): **module**, **interface**, **seam**, **adapter**, **leverage**.

## Process

### 1. Frame the problem space

Explain the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](DEEPENING.md))
- A rough illustrative code sketch to ground the constraints, not a proposal, just a way to make the constraints concrete

Show this to the user, then proceed to the alternatives.

### 2. Design alternatives

Design three genuinely different interfaces yourself before ranking them. Use the same problem constraints, file paths, coupling details, and dependency facts for each. Vary the priority:

- Minimize the interface, aiming for one to three entry points with high leverage.
- Maximize flexibility across the required use cases and extension needs.
- Optimize for the most common caller so the default case is trivial.

Add a ports-and-adapters alternative when cross-seam dependencies warrant it. Alternatives must differ in responsibilities or interface shape, not just names. These are different design passes, not independent assessments.

Use both [SKILL.md](SKILL.md) vocabulary and CONTEXT.md vocabulary consistently. For each alternative, show:

1. Interface (types, methods, params, plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md))
5. Trade-offs: where leverage is high, where it's thin

### 3. Present and compare

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated: the user wants a strong read, not a menu.
