---
name: principle-exhaust-the-design-space
description: Compare designs before adding custom infrastructure or another mechanism for an existing responsibility, when workarounds accumulate, or when consequential tradeoffs remain unresolved.
---

# Explore the design space

Start with the existing implementation or the adopted stack's native mechanism and the proposed alternative. Compare their responsibilities, constraints, and maintenance cost. Explore further alternatives only if neither fits.

Use [documentation search](../docs-search/SKILL.md) when the native capability or its limitations are uncertain. Keep specialized exceptions limited to the requirements that need them.

Use brief reasoning or sketches. Build prototypes only when running them will resolve a consequential uncertainty. Proceed when you can briefly explain which mechanism owns each responsibility and why any custom exception is necessary.

Follow an established pattern when it fits. Mechanical changes and clear fixes do not need an alternatives exercise.
