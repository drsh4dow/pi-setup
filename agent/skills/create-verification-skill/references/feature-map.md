# Feature map contract

Keep the map small and user-facing. `features/README.md` contains:

- the app identity and purpose of the map
- baseline launch, health, isolation, auth, and fixture preconditions
- harness conventions and artifact location
- proof and skip-reporting rules
- a linked index of every feature file

Each feature file starts with an H1 title and one paragraph describing visible behavior. Follow it with exactly these H2 sections in this order.

## Sub-features

List short IDs and one observable behavior for each. Cover meaningful states such as success, cancellation, empty results, or persistence only when the repository shows them.

## How to get to it (user POV)

List every known user entry point: controls, keyboard commands, routes, terminal commands, or public endpoints. Keep implementation details out.

## Driving it with <harness>

Start with `Preconditions:`. Pair each user action with a literal harness command and its expected observable result. End with the evidence command and a second user-facing or read-only side-effect check where the feature mutates state.

## Gotchas

Record traps that can invalidate proof, such as focus-sensitive shortcuts, debounce, stale auth, shared state, output modes, or navigation that changes the next precondition. Omit generic advice.
