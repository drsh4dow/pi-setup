---
name: abstraction-economics
description: Use when adding or changing abstractions.
user-invokable: false
---

Every abstraction charges rent. Future readers must learn its name, find its definition, test it, debug it, and migrate it. Add one only when it repays that cost.

## What earns a name

Before adding a name, identify at least one concrete benefit:

1. The caller now tracks fewer concepts, paths, or states. Moving code elsewhere does not count.
2. One place now enforces an invariant that callers could previously violate.
3. A small interface hides substantial implementation complexity. A wrapper that repeats the wrapped signature hides nothing.
4. Multiple call sites use it now. A possible second caller is speculation.

A single-use name can also earn its place by stating domain meaning, such as `grace_period`, or by defining a contract at a boundary the project owns.

If none applies, inline it. Explicit local code is the baseline.

## Common rulings

Apply each ruling the change touches.

- A getter or setter earns its place by enforcing an invariant or hiding a representation that varies. Otherwise expose the field.
- A single-use helper must name a domain operation or hide real complexity. If the caller still requires reading the helper to understand the flow, inline it.
- A pass-through wrapper is useful when it protects a boundary the project owns from one it does not, such as an SDK, wire format, or process edge. Otherwise it is another hop.
- A constant should carry domain meaning, recur, or need one-point changes. Keep a one-off, self-evident value literal.
- A configuration option multiplies runtime states and test paths. Add one only when live deployments need different values now.
- An interface or generic with one implementation usually predicts the wrong second implementation. Wait for that implementation to reveal the shared shape.
- A long function may remain whole when it tells one coherent story. Split it only when the extracted function names a domain step, removes duplication, or hides complexity.
- A module or layer must give callers a simpler contract. If callers still reach through it, delete the hop.

This pass is complete when every new named unit has one of these benefits. Keep the reasoning in the design or review record, not in a code comment unless the code cannot show the constraint itself.
