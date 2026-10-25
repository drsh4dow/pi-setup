// A value read from a run's records, or the reason the records cannot settle it.

export type Measured<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly reason: string };

export function known<T>(value: T): Measured<T> {
  return { known: true, value };
}

export function unknown<T>(reason: string): Measured<T> {
  return { known: false, reason };
}
