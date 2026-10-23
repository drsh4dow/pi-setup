# Contributing

Run `npm test` before you push. Reviews check these rules.

1. **Money is integer cents.** Every amount is a whole number of cents, in a field or
   variable named `...Cents` and typed `Cents` from `src/money.ts`. No floats, no dollars.
2. **Time comes from the clock.** Code under `src/` never reads the current time with
   `Date.now()` or `new Date()`; only `src/main.ts` wires the real clock. HTTP handlers read
   `deps.clock.now()` once and pass the `Date` down as an `at` argument. Tests use a fixed
   clock.
3. **Expected failures are returned, not thrown.** A function that can fail for a reason its
   caller handles (bad input, an illegal transition, an unknown plan) returns a `Result` from
   `src/result.ts`. `throw` is for broken invariants only.
4. **Webhook payloads are versioned.** Integrations parse `data` by the event's `version`.
   Adding, removing, renaming, or retyping a field in a payload built by `src/payloads.ts`
   bumps that payload's entry in `PAYLOAD_VERSIONS` (`src/events.ts`) and adds a line to the
   changelog at the end of `docs/webhooks.md`, in the same change.
