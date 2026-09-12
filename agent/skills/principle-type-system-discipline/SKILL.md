---
name: principle-type-system-discipline
description: Use types and boundary parsing to remove concrete failure modes in typed code.
---

# Type system discipline

Use types to track the cases callers must handle and remove runtime machinery. Strengthen a type where it prevents a real mistake, rather than to describe every fact about a value.

- Model mutually exclusive states as variants when optional fields admit contradictory combinations.
- Match variants exhaustively so the compiler identifies affected callers when the model changes.
- Derive shapes from authoritative schemas or generated types when available.
- Parse untrusted input at its boundary using the repository's existing validation conventions. Avoid redundant validation of unchanged, already-validated data.
- Use semantic brands when otherwise interchangeable values cause credible mistakes. Keep ordinary local values simple.
- Prefer a total result or a stronger input where an operation can otherwise fail. An empty list can sum to zero; selecting its first element needs an absence result or a non-empty input.
- Narrow values rather than asserting facts the compiler has not established. Keep unavoidable assertions constrained to a boundary with a justified contract.

Types establish particular guarantees. A start plus a numeric duration still permits negative or non-finite durations. Validate such constraints when the contract requires them; changing the representation alone does not prove them.

Keep internal error handling and checks for mutable invariants where failures can actually occur. Trust established guarantees without treating internal code as infallible.
