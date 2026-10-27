# Coding standards

## Changing code

Judge every decision in this repository's code and output by the AX (Agent
Experience) it gives the harness.

## Package scripts

Use `vp` for package management and scripts.

## Tests

Run a test or dogfood run that stubs `gh` in its own `mktemp -d` directory,
with a `PATH` that cannot reach the real `gh`.

## Effect code

Before writing Effect code, read `.repos/effect/LLMS.md` and inspect its source
and tests for idiomatic usage, module structure, and API design. Use the
submodule as read-only reference and keep application imports on the installed
`effect` and `@effect/*` packages. When `.repos/effect` is empty, initialize it
with `git submodule update --init --recursive`.
