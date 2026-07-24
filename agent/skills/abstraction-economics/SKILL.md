---
name: abstraction-economics
description: Use when working with code always. Teaches you when to abstract correctly.
user-invokable: false
---

Every name is a loan. A helper, wrapper, interface, or module borrows attention from every future reader: one more place to look, one more hop between intent and behavior. **Rent** is the ongoing cost - reading, testing, debugging, migration, ownership. The economics are blunt: an abstraction lives only while it pays rent, and the cheapest abstraction is the one never introduced.

This skill fires at design time, at the moment of naming. Its post-implementation counterpart is `beauty-gate`, which audits the finished diff; the earning criteria below are the single source of truth both passes judge against.

## The earning criteria

An abstraction pays rent through at least one of four earnings. Name the earning before writing the name.

1. **Cognitive load** - the caller now holds fewer concepts, paths, or states in mind. Moving code between files changes its location, not its load.
2. **Invariant** - the abstraction makes an illegal state unrepresentable, or centralizes enforcement that was scattered.
3. **Hidden complexity** - a deep module: an interface much simpler than the implementation it conceals. Depth is the ratio, so a wrapper whose signature mirrors what it wraps has depth zero.
4. **Real reuse** - multiple call sites exist today. A second caller that might arrive is speculation, and speculation pays no rent.

A single-use name earns one extra way: when it states domain meaning (`grace_period`) or defines a contract at a boundary you own. Relocating an obvious expression under a label is a move, not an earning.

Default verdict when no earning can be named: **inline**. Boring, explicit, local code is the baseline every abstraction must beat.

## Rulings

Flat reference - apply every ruling the change touches. Criterion: every named thing the change introduces carries a named earning, or is inlined.

- **Getter/setter over a plain field**: earns only by enforcing an invariant or hiding a representation that actually varies. Otherwise the field is the interface.
- **Single-use helper**: earns via domain meaning or a real contract. Extracted "for readability" while the caller must still read it to understand behavior - inline it.
- **Wrapper / pass-through**: depth zero by construction. Earns only by pinning a boundary you own against one you don't (an external SDK, a wire format, a process edge).
- **Constant**: earns when the value carries meaning (`MAX_RETRIES`), recurs, or must change everywhere at once. A value used once and self-evident in context stays literal.
- **Configuration option**: the most expensive abstraction - it multiplies states and test paths forever. Earns only when two live deployments need different values today. A hardcoded decision is a feature.
- **Interface / generic with one implementation**: speculation. Introduce it with the second implementation, which will also reveal the right shape.
- **Function split**: a function may stay long while it reads as one coherent story. Split when the extracted piece earns as its own abstraction - hides real complexity, removes real duplication, or names a domain step - and keep it whole when the split would only satisfy a length rule.
- **New module / layer**: earns only as a deep module. When callers still reach around or through it, it is a hop, not a layer.

## Verdict discipline

State the earning where the abstraction appears - design note, review comment, or commit message; one clause suffices ("wrapper pins the Stripe SDK boundary"). Criterion: a reviewer can find, for every introduced name, which earning it claims. Inlining needs no defense.
