# Contributing

Run `npm test` before you push. Reviews check these rules.

1. **Money is integer cents.** Every amount is a whole number of cents in a field or
   variable named `...Cents` and typed `Cents`. No floats, no dollar amounts. Rates are
   integer basis points, applied with `applyBasisPoints` from `src/money.ts`.
2. **Expected failures are returned, not thrown.** Functions that can fail for a reason the
   caller handles (bad input, an illegal transition, a missing order) return a `Result` built
   with `ok` and `err` from `src/result.ts`. `throw` is for bugs only.
3. **Time comes from the clock.** Code under `src/` never calls `Date.now()` or
   `new Date()` for the current time; only `src/main.ts` wires the real clock. HTTP handlers read `deps.clock.now()` and pass the
   `Date` down; domain functions take it as an `at` argument. Tests use a fixed clock.
4. **Every exported function has a doc comment** saying what it returns and when it fails.
