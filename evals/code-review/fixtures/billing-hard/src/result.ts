export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Returns a successful Result holding `value`. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Returns a failed Result holding `error`. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
