# invoices

Rules for anyone changing this repository. `scripts/check.sh` enforces the ones marked
(gate); CI runs it on every pull request.

- Every change under `src/` adds a line under `## Unreleased` in `CHANGELOG.md`. (gate)
- Tests live in `test/` and run with `node --test`. (gate)
- AWS access goes through the `staging` profile: `aws --profile staging ...`. Never use another profile.
