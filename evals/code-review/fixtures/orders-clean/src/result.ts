/** The outcome of an operation that can fail in a way the caller handles. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Returns a successful result holding `value`. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Returns a failed result holding `error`. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
