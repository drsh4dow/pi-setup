# Anti-slop provenance

- Source: <https://github.com/dmmulroy/anti-slop>
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied directory: `skills/install-anti-slop/assets/anti-slop/`
- Generic entry point: `tools/oxlint/anti-slop/index.ts`
- Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`

All bundled source files match that commit byte for byte. Local additions are
this record and the upstream root MIT `LICENSE`. The nested ESLint Stylistic
license and provenance remain intact. No rules were customized.

## Repository integration

`vite.config.ts` enables every generic and Effect anti-slop rule at error
severity, plus native `oxc/no-accumulating-spread`. Vite+ supplies Oxlint and
Oxfmt. `@oxlint/plugins` is the authoring API used by this vendored plugin, not
another linter. Keep it compatible with Vite+'s bundled Oxlint, and keep
`@effect/tsgo` compatible with both Oxlint and its type-checking binary.

`vp lint` checks maintained extensions, libraries, scripts, babysit-pr code, and
dumpfile source and tests. `vp check` adds formatting and type checks;
`vp run verify` also builds the CLI binaries and runs behavioral tests.

Runtime state, other installed skills, reference checkouts, and this vendored
plugin are excluded from application checks. Native host boundaries have scoped
Effect-native exceptions, but keep type-safety and anti-slop rules enabled.

The service-constructor rule checks relative project imports, not package or
path-alias imports.

## Verification

`vp run verify:strict-diagnostics` exercises the real `vp check` command in a
clean temporary repository. It checks source discovery, TypeScript errors,
formatting failures, typed lint, Effect diagnostics, anti-slop enforcement,
warning failure, and the file-length limit. The full verification suite includes
this check. Use `vp lint --format json` for current findings.
