/** A whole number of cents. */
export type Cents = number;

/**
 * Returns `basisPoints` / 10000 of `amountCents`, rounded to the nearest cent with halves
 * rounded up. 825 basis points is 8.25%.
 */
export function applyBasisPoints(amountCents: Cents, basisPoints: number): Cents {
  return Math.round((amountCents * basisPoints) / 10_000);
}
