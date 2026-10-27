# Coding standards

## Dependencies and scripts

Manage dependencies and run scripts with `vp`.

## Tests

Wait for a printed readiness line or an event, with a budget of at least 5
seconds. Parallel subagents load the host, and tests that slept for a fixed
time flaked under that load (#133, #138, #154, #155, #168). Replace a fake file
that the code polls atomically: write a temporary file, then rename it over the
old one.

Run a test or dogfood run that stubs `gh` in its own `mktemp -d` directory,
with a `PATH` that cannot reach the real `gh`.

## Effect code

Read `.repos/effect/LLMS.md`, then model your modules and APIs on the idioms in
its source and tests. Treat the submodule as read-only reference, and import
from the installed `effect` and `@effect/*` packages. Initialize an empty
`.repos/effect` with `git submodule update --init --recursive`.
