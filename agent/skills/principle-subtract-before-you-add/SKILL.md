---
name: principle-subtract-before-you-add
description: "Apply before adding a feature, option, or code path to existing code, and before a refactor or rewrite: first look for what to delete."
disable-model-invocation: false
user-invokable: false
---

# Subtract Before You Add

When evolving a system, remove complexity first, then build. Default to subtraction.

Make simplification a continual investment. Leave the design slightly simpler and more capable behind the same or smaller surface than you found it.

- Sequence removal before construction
- Cut before you polish (get to the minimum before investing in quality)
- Design for observed usage, not speculative edge cases. Build the features the request asks for, not the ones that seem useful.
- Learn why a comment or odd-looking code exists before you delete it
- No speculative validators, parsers, or guards beyond what the spec demands
- Simplify prompts (remove redundant instructions, excessive templates)
- When a reference has no novel content, delete it rather than leaving a stub
