---
name: principle-laziness-protocol
description: "Apply before adding a feature, option, or code path to existing code, before a refactor or rewrite, when sizing a diff, or when tempted to add abstractions, layers, or signal threading."
disable-model-invocation: false
user-invokable: false
---

# Laziness Protocol

Aim for the most result with the least code and complexity.

- **Prefer deletion.** When asked to refactor or improve, look for removals before additions.
- **Keep the call hierarchy flat.** A rich interface that hides substantial work is not a deep call chain. If answering a question requires tracing through more than 3 files or layers, flatten it, per [Minimize Reader Load](../principle-minimize-reader-load/SKILL.md).
- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- **Make the smallest end-state change.** Solve the problem with the least code and complexity left once the change lands. Count what remains, not the lines the diff touches: a redesign that leaves less code beats a patch that leaves more. Fewer lines beat "elegant" boilerplate.
- **Question the threading.** If a task asks you to pass a new signal through types, schemas, pipelines, or similar layers, stop and look for a more direct path.
- **Sweat the small leaks.** Remove tiny pass-throughs, representation leaks, and duplicated choices before they spread. Small leaks compound into permanent coordination costs.

## Subtract before you add

When evolving a system, remove complexity first, then build.

Make simplification a continual investment. Leave the design slightly simpler and more capable behind the same or smaller surface than you found it.

- Sequence removal before construction
- Cut before you polish (get to the minimum before investing in quality)
- Design for observed usage, not speculative edge cases. Build the features the request asks for, not the ones that seem useful.
- Learn why a comment or odd-looking code exists before you delete it
- No speculative validators, parsers, or guards beyond what the spec demands
- Simplify prompts (remove redundant instructions, excessive templates)
- When a reference has no novel content, delete it rather than leaving a stub

**The test:** If a human developer would find the code exhausting to maintain, it is a bad solution.
