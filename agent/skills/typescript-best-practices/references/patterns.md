# TypeScript patterns

Use these examples as forms, not mandates. Match the repository's semicolons, naming, schema library, and error conventions.

## Non-empty inputs

```ts
type NonEmpty<T> = [T, ...T[]]

function newestSession(sessions: NonEmpty<Session>): Session {
  return sessions[0]
}
```

Use this when empty is invalid for the operation. If empty has domain meaning, return it in the type instead:

```ts
function newestSession(sessions: readonly Session[]): Session | undefined {
  return sessions[0]
}
```

## Semantic identifiers

```ts
declare const userIdBrand: unique symbol

type UserId = string & { readonly [userIdBrand]: true }

function parseUserId(input: string): UserId {
  if (!isUuid(input)) throw new InvalidUserId(input)
  return input as UserId
}
```

The assertion is contained in the constructor after validation. If the project uses a schema library, derive the branded value through that library instead.

## Boundary parsing

With Effect, use `Schema` to define and decode the boundary instead of duplicating a manual guard:

```ts
import { Schema } from "effect"

const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

type User = typeof User.Type

const decodeUser = Schema.decodeUnknown(User)
```

Use the exact API style established by the installed Effect version and nearby code. For projects using Zod, Valibot, generated codecs, or another established decoder, keep that single validation vocabulary.

A manual parser remains reasonable in a small project without a schema dependency:

```ts
function parsePort(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 65535) {
    throw new Error("port must be an integer from 1 to 65535")
  }
  return input
}
```

## Honest guards

```ts
function isCircle(shape: Shape): shape is Extract<Shape, { kind: "circle" }> {
  return shape.kind === "circle"
}
```

A guard over `unknown` must check the whole claimed shape, not one convenient field. A schema decoder is usually clearer for nested values.

## `satisfies`

```ts
const config = {
  theme: "dark",
  columns: 3,
} satisfies Config
```

This checks compatibility while preserving useful inference. An annotation is better when consumers should see the wider declared type:

```ts
const config: Config = {
  theme: "dark",
  columns: 3,
}
```

## Derived types

```ts
import type { ChecksMessage } from "./generated/checks"

type CheckSummary = Pick<ChecksMessage, "totalCount" | "checks">
```

Do not derive merely because utility types are available. A named interface can communicate a distinct domain contract and insulate it from generated transport changes.

## Object arguments

```ts
function openFile(options: {
  uri: Uri
  selection?: Selection
}): void {
  // implementation
}

openFile({ uri, selection })
```

An object earns its allocation and syntax when names prevent mistakes or the API is evolving. `clamp(value, min, max)` and other conventional, compact operations can stay positional.
