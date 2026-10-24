# tally

A small HTTP service. Node 22 or later, no dependencies.

## Rules

- Do not write code comments. A name, a test, or the commit message carries the why. Longer rationale goes in `docs/decisions.md`.
- Every user-visible change adds a line under `## Unreleased` in `CHANGELOG.md`. CI fails a pull request that changes `src/` without changing `CHANGELOG.md`.
- `npm run check` is what CI runs: the tests and the changelog rule.

## Commands

- `npm test`: unit tests (`node --test`).
- `npm run check`: what CI runs on every pull request, whatever its base.
- `npm run dev`: serve from `src/` on `PORT` (default 8080).
- `npm run build`: build the deploy artifact into `dist/`. Production serves `dist/`, never `src/`.

## Issue tracker

See `docs/agents/issue-tracker.md`.
