---
name: typescript-best-practices
description: Apply TypeScript-specific conventions when writing or reviewing TypeScript code.
paths: ["**/*.ts", "**/*.tsx"]
---

# TypeScript best practices

Follow the repository's discriminant, branding, schema, and error conventions. For decisions about domain types or validation boundaries, consult [type system discipline](../principle-type-system-discipline/SKILL.md).

- Use `unknown` for untrusted values and narrow before access. Reuse existing runtime schemas rather than maintaining parallel schemas, interfaces, and property guards. A trivial local check does not need a schema dependency.
- Use discriminated unions when states have different required fields. Match exhaustively using the repository's idiom, such as a `never` assignment.
- Prefer `satisfies` to check a value against a type without replacing its inferred type with an assertion. It is a compile-time check, not runtime validation.
- Keep unavoidable assertions constrained and justified, such as a validated brand constructor or an interop contract the compiler cannot express. `as const` is useful for literal inference.
- Derive types from authoritative definitions where that keeps ownership clear. Avoid complex utility-type expressions that are harder to read than the shape they replace.
- Use simple positional arguments when meaning is clear. Use object arguments when names prevent confusion or several options belong together.
- Keep type guards honest: each guard must establish the fact its return type claims.
- Use the repository's logging facilities with enough context to diagnose the operation. Keep intended CLI output distinct from diagnostics.

For concrete narrowing and modeling examples, read [patterns.md](references/patterns.md).
