---
name: tdd
description: Implement meaningful behavior test-first when the user requests TDD or test-first work.
---

# Test-driven development

Select a credible, non-obvious failure before writing a test. Explicit TDD does not make obvious behavior or implementation restatements worth testing.

## Red, green, refactor

1. Choose the smallest existing interface that exercises the failure. Infer it from the requested behavior and repository conventions. Ask only if choosing it would establish an unresolved contract or materially change scope.
2. Write a focused test and observe it fail for the intended reason.
3. Implement the simplest coherent solution and observe the test pass.
4. Simplify while green. Repeat for another meaningful failure only when needed.

Work in coherent increments rather than writing a speculative test matrix first. Use domain vocabulary from relevant repository documentation.

## Assertions and dependencies

Establish expected results independently of the implementation: a specified outcome, a worked example, an observed effect, or a trustworthy reference. An independently computed expectation is not inherently tautological; copying the algorithm under test adds little confidence.

Choose assertions by the failure they catch. Absence checks and calls to external collaborators can be meaningful when absence or communication is the contract. Assertion syntax alone does not determine quality.

Reuse existing infrastructure and test substitutes. Exercise real communication when serialization, transport, retries, or lifecycle interaction is the failure of interest. Use a constrained substitute when a dependency is impractical or consequential to run. Avoid mocking internal steps merely to assert how the implementation works.

Keep setup small. If testing requires disproportionate machinery, reconsider the interface or use a direct reproduction instead of retaining a low-value test. When the interface itself needs design work, consult [codebase-design](../codebase-design/SKILL.md).
