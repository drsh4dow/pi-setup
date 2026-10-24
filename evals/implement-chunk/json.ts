/** A value `JSON.stringify` writes without loss: what the fake `gh` and tracker print. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
