# Deepening modules

Consolidate shallow modules when doing so concentrates knowledge and reduces what callers must coordinate. Use the concepts in [SKILL.md](SKILL.md).

## Dependencies

Choose a dependency strategy that fits the actual boundary:

- **In-process computation:** use directly. A new adapter rarely helps.
- **Local infrastructure:** reuse the project's test database or other existing stand-in when its semantics cover the failure of interest.
- **Owned remote services:** keep transport details behind a useful interface. Use a real integration path when communication is what needs verification; an in-memory implementation cannot establish wire compatibility.
- **Third-party services:** use a constrained substitute when the real dependency is impractical or consequential to call. Keep it faithful to the relevant contract.

A boundary can earn its place through ownership, information hiding, or substitution. Do not create a second adapter just to justify the first.

## Existing tests

Inspect which meaningful failures the old tests protect before removing them. Preserve that protection through the new interface where needed. Delete obsolete implementation-coupled and redundant tests during the refactor, without replacing each deleted test by default.

Keep test setup proportionate to the failure it protects against. Do not expose private internals solely for test access.
