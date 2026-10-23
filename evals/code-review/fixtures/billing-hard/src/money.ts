/** A whole number of cents. */
export type Cents = number;

/**
 * Returns `amountCents * numerator / denominator`, rounded to the nearest cent with halves
 * rounded away from zero. Throws a RangeError when `denominator` isn't positive: callers
 * divide by a count they control, so that is a broken invariant.
 */
export function scaleCents(amountCents: Cents, numerator: number, denominator: number): Cents {
  if (!(denominator > 0)) throw new RangeError(`scaleCents: denominator must be positive, got ${denominator}`);
  const scaled = (amountCents * numerator) / denominator;
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/** Returns `basisPoints` hundredths of a percent of `amountCents`, rounded like scaleCents. */
export function applyBasisPoints(amountCents: Cents, basisPoints: number): Cents {
  return scaleCents(amountCents, basisPoints, 10_000);
}

/** Returns the sum of `amounts`, 0 for none. */
export function sumCents(amounts: readonly Cents[]): Cents {
  return amounts.reduce((total, amount) => total + amount, 0);
}

/** Returns `amountCents` as dollars for invoice descriptions, such as `$12.50` or `-$3.00`. */
export function formatCents(amountCents: Cents): string {
  const sign = amountCents < 0 ? "-" : "";
  const absolute = Math.abs(amountCents);
  return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
