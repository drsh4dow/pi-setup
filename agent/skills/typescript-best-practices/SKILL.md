---
name: typescript-best-practices
description: Use for TypeScript work.
disable-model-invocation: false
user-invokable: false
---

# TypeScript best practices

Use the compiler to carry facts that callers would otherwise repeat or forget. First inspect the repository's TypeScript configuration, nearby code, generated types, validation library, and tests. Match established project idioms unless they weaken a concrete safety property. Prefer the smallest type that keeps the operations at hand total.

## Working method

1. Locate the authoritative shape and the boundary where values enter the typed program.
2. Identify the actual invalid states, partial operations, unsafe assertions, or duplicated schemas in the changed path.
3. Choose a representation that removes those failures without adding precision callers do not need.
4. Parse untrusted input once at its boundary. Keep the interior typed rather than repeating validation down the call chain.
5. Let normal control flow narrow values. Use explicit assertions only where TypeScript cannot express a fact that runtime code has established.
6. Run the repository's typecheck and focused tests. A type-only improvement is incomplete if runtime parsing or emitted behavior changed without a test.

For concrete forms and tradeoffs, read [references/patterns.md](references/patterns.md).

## Type design

### Model variants directly

Use a discriminated union when fields belong to distinct states. A boolean plus optional fields often admits contradictory combinations.

```ts
type DiffState =
  | { kind: "loading" }
  | { kind: "ready"; diff: GitDiff }
  | { kind: "error"; message: string }
```

Follow the local discriminant name, such as `kind`, `type`, or `_tag`. Do not churn a consistent codebase merely to standardize spelling.

### Construct valid values

Build invariants into the representation when that simplifies callers. A non-empty sequence can be `[T, ...T[]]`; pairs can be `[T, T][]`; an ordered interval can be a start plus a validated duration. Expose operations in terms of that representation instead of storing a loose value and scattering checks.

Keep a plain type when its operations already handle every value. For example, `sum(number[])` can define the empty result as zero. Strengthen an input to `NonEmpty<T>` when an operation otherwise needs `!`, a cast, or a "should never happen" throw. Returning `T | undefined` may be simpler when the caller owns the empty case.

### Distinguish semantic primitives selectively

Use the project's existing brand, opaque type, or class convention when mixing primitives would be a realistic bug, such as passing an `OrderId` where a `UserId` is required. Validate at construction and keep creation controlled.

Branding every string or number adds conversion code and reduces interoperability. Leave values structural when their context is unambiguous or the project deliberately uses schemas or classes instead.

### Derive rather than duplicate

Prefer generated schema types and TypeScript utilities such as `Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, and `typeof` when another declaration owns the shape. A local domain type is still justified when it represents a different concept rather than a projection of the source type.

## Trust and narrowing

Treat data from JSON, RPC, IPC, files, environment variables, CLI arguments, databases, and browser messaging as `unknown` until parsed. Use the repository's schema or decoder library when one exists. In Effect code, follow the repository's Effect guidance and use `Schema` for untrusted data rather than introducing parallel manual parsers. Consult the installed Effect source and tests for idiomatic APIs.

Prefer narrowing that the compiler can inspect:

1. discriminant checks or exhaustive switches
2. `in`, `typeof`, and `instanceof`
3. a user-defined type guard that verifies every fact it claims
4. a narrow assertion after runtime validation or at an external typing gap

Avoid `any` in application code because it spreads unchecked operations. It can be appropriate at a tightly contained compatibility seam when upstream declarations cannot model the API. Document the external constraint and prevent the value from escaping before it is narrowed.

An `as` assertion is not validation. Remove assertions that merely silence a mismatch. A cast can be warranted after runtime validation, for literal inference limitations, or at a known library boundary. Keep it close to the proof and narrow its scope. Prefer `satisfies` when the goal is to check an object while preserving inferred literal types.

Type guards must prove their predicate. Prefer ordinary discriminant checks when they are equally clear because readers can see the proof at the use site.

## Exhaustive variants

Make additions to a closed union fail compilation at each required match. Use the local helper if the project has one. Otherwise a `never` binding keeps the check visible:

```ts
function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius ** 2
    case "rectangle":
      return shape.width * shape.height
    default: {
      const exhaustive: never = shape
      return exhaustive
    }
  }
}
```

Do not force exhaustiveness onto intentionally open protocols. Unknown external variants need an explicit fallback after boundary decoding.

## API shape

Use object parameters when several same-typed positional arguments are easy to swap, when optional arguments are growing, or when call-site names materially improve comprehension. Preserve concise positional APIs for conventional operations and measured hot paths. Follow existing public API compatibility constraints.

Keep state transitions and invariants visible in signatures. Do not add wrappers, brands, or helper aliases solely to make a type look more precise.

## Verification and diagnostics

Test parsing failures and representative valid values at external boundaries. Test each meaningful union variant. Prefer real framework primitives over mocks when they are cheap and deterministic; mock dependencies that cannot run locally or would make the test unreliable.

Use the project's logger and telemetry conventions in shipped code. Diagnostics should include stable identifiers and enough structured context to locate the failed operation. Temporary `console` output should not remain after verification unless the runtime or project explicitly treats it as its logger.
