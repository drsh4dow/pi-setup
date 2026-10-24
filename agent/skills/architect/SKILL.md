---
name: architect
description: "Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for 'architect this', 'design this', or non-trivial work where jumping to code would lock in the wrong shape."
disable-model-invocation: false
user-invokable: false
---

# Architect

Sketch types, function signatures, class shapes, and module boundaries with `not implemented` bodies and pseudocode. Synthesize across multiple model perspectives, then fill in code against the chosen sketch.

## Start

Open a todolist with one entry per phase before starting.

1. Ground
2. Sketch
3. Review
4. Agree
5. Implement
6. Scrap

## Phase A: Ground the problem

Build a real mental model of every system the new code touches. Run the **how** skill over the relevant subsystems. Naming a file isn't grounding. Produce the architectural explanation `how` prescribes. If the design redefines ownership or layering, also run the **why** skill on the existing shape so the rationale becomes a constraint, not a guess.

Skip Phase A only when the work is genuinely greenfield with no surrounding system to integrate. An upstream example or template grounds only the parts it covers.

## Phase B: Sketch

Run the **arena** skill with the design-sketch task and the Phase A grounding artifacts. Pass `references/runner-prompt.md` as each runner's prompt.

Take the runners from the `architect runners` role in the subagents skill, in place of the `arena runners` role.

Run Phase B on every part of the design that no upstream example covers. When you replace a phase with a lighter substitute, such as one second opinion instead of an arena, add the substitute to the todolist so it runs.

Design it twice. Require at least two structurally distinct candidates before synthesis, even when the first looks sufficient. This is the **exhaust-the-design-space** principle skill made concrete. Whole-shape alternatives, not point fixes inside one shape.

Give each runner a different design constraint, so the candidates differ in shape and not only in model. Pick the constraints that fit the problem, at least two, and run one runner per constraint, cycling through the role's models. The constraint is the one input that differs between runners.

- Minimize the interface: one to three entry points, the most leverage per entry point.
- Maximize flexibility: support many use cases and extension.
- Optimize for the most common caller: make the default case trivial.
- Design around ports and adapters, when dependencies cross a seam. The dependency categories are in the codebase-design skill's [`DEEPENING.md`](../codebase-design/DEEPENING.md).

Screen every candidate against [`references/design-red-flags.md`](references/design-red-flags.md) before synthesis. Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.

Compare viable candidates on depth, locality, and seam placement, in the vocabulary of the **codebase-design** skill. Prefer the deeper module: more behavior behind a smaller interface. A rich interface can keep call chains short by concentrating capability instead of scattering it across layers.

Arena returns one synthesized design package. Its synthesis decision fills the rationale's "Synthesis decision" section.

Review the synthesis. Arena's cross-judge scored the candidates before the graft, so no other model has read the synthesized sketch. Launch one reviewer per model of the `architect reviewers` role in the **subagents** skill, all at once, each a delegate that changes nothing. Build each assignment from [`references/sketch-reviewer-prompt.md`](references/sketch-reviewer-prompt.md), with the design task as the intent, the sketch files, and the absolute path of [`references/design-red-flags.md`](references/design-red-flags.md). Leave out your reasoning about the sketch: a reviewer handed your conclusions returns validation of them.

Merge findings that name the same problem, and note which models raised each: a problem two models found independently is the strongest signal. Then judge every finding as the lead, per the code-review skill's [lead judgment framework](../code-review/references/lead-judgment.md): **Act on** when the design cannot meet the task or will force a rewrite, **Consider** when it is legitimate but its cost is unclear, **Noted** when it is valid but not actionable, **Dismissed** with a one-line reason. Fold every Act on finding into the sketch, and carry the Consider findings into Phase C.

## Phase C: Agree (opt-in)

Default: proceed directly to implementation with the synthesized design. No human checkpoint. Record the Consider findings under the rationale's "Open questions and risks".

Opt in to a checkpoint when the invoker explicitly asks: "architect this with a checkpoint," "stop and show me before implementing," or similar. Then surface the synthesized design and apply the **grilling** skill to it. The Consider findings and the decisions the sketch opened form the first frontier. Decisions settled earlier in the session stay settled. Implement once the frontier is empty and the human signs off.

The synthesis can ship as its own commit either way, as the "scaffold first" step of the **sequence-verifiable-units** principle skill. Each fill-in unit still ends in a passing check, per the same principle.

If the human pushes back on the shape (in a checkpoint or after the fact), treat that as Phase A evidence. Re-ground and re-run Phase B before writing more code.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code, pseudocode with logic. The synthesized sketch is the contract. Deviations from it are signal to surface, not friction to absorb silently. If a function needs a parameter the sketch didn't anticipate, ask whether the sketch was wrong, the requirement was missed, or the implementation is overreaching.

## Phase E: Scrap when the architecture is wrong

If implementation keeps producing friction the sketch can't absorb, throw the sketch out. Don't bolt fixes onto a wrong design, per the **redesign-from-first-principles** and **fix-root-causes** principle skills.

The signal is a *pattern*, not single instances. Tells:

- The same shape of workaround appearing repeatedly across unrelated code.
- Multiple unrelated edge cases that all need special-case branches.
- Types that need escape hatches (`any`, casts, optional fields always set in practice) to compile.
- The "we need a lock" reflex when the sketch said the state wasn't shared.
- Callers having to know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations of the same shape across the implementation.

Use judgment. A few edge cases don't condemn an architecture. Some problems are legitimately complex. Complexity in the data is not complexity in the design.

When you scrap:

1. Re-run the **how** skill over what's been built.
2. Redesign as if the new constraints had been day-one assumptions, per redesign-from-first-principles.
3. Subtract before adding, per the **laziness-protocol** principle skill. The new sketch should be smaller than the old one before it grows.
4. Return to Phase B and re-run arena.

## Outputs

The caller's usage is written first and the type sketch derived from it. One file with new types and signatures for small changes. Module map plus type definitions for larger work. The rationale ships alongside, shaped per `references/rationale-template.md`, including the usage sketch and the synthesis decision.
