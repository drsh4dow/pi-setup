# invoices

Rules for anyone changing this repository. `scripts/check.sh` enforces the ones marked
(gate); CI runs it on every pull request.

- Every change under `src/` adds a line under `## Unreleased` in `CHANGELOG.md`. (gate)
- Tests live in `test/` and run with `node --test`. (gate)
- Source files under `src/` carry no comments. Document each export in the README's API section instead. (gate)
