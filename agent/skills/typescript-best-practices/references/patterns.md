# TypeScript patterns

Use these shapes when they remove a concrete failure mode. Follow existing naming and schema conventions.

## Lifecycle variants

```ts
type DiffState =
  | { kind: "loading" }
  | { kind: "ready"; diff: string }
  | { kind: "failed"; error: Error };

function describeDiff(state: DiffState): string {
  switch (state.kind) {
    case "loading":
      return "Loading";
    case "ready":
      return state.diff;
    case "failed":
      return state.error.message;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
```

The union couples each state to its required data. A new variant makes the unhandled case a compile error.

## Narrowing external input

Prefer the repository's existing schema for structured payloads. A small check can stay direct:

```ts
function parseName(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Expected a non-empty name");
  }
  return input.trim();
}
```

A branded constructor may need an assertion after validation; reuse the repository's branding convention. Do not spread assertions across consumers.

## Total operations

```ts
function first<Value>(values: readonly Value[]): Value | undefined {
  return values[0];
}
```

An absence result is often enough. Require a tuple such as `readonly [Value, ...Value[]]` only when callers must guarantee an element exists. A non-empty tuple guarantees index zero, not every arbitrary numeric index.

## Representation limits

```ts
type TimeRange = { start: Date; durationMs: number };
```

This shape does not prohibit negative or non-finite durations, nor invalid dates. Validate those properties at construction when the domain requires them. Add a stronger type only when carrying that guarantee prevents a real downstream mistake.
