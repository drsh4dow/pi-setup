# Coding standards

## Effect

Before writing Effect code, read `.repos/effect/LLMS.md` and inspect its source
and tests for idiomatic usage, module structure, and API design. Use the
submodule as read-only reference and keep application imports on the installed
`effect` and `@effect/*` packages. When `.repos/effect` is empty, initialize it
with `git submodule update --init --recursive`.
