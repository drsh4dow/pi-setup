# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Copied directory: `skills/install-anti-slop/assets/anti-slop/`
- Generic entry point: `tools/oxlint/anti-slop/index.ts`
- Effect entry point: `tools/oxlint/anti-slop/effect/index.ts`

All bundled source files match that commit byte for byte. Local additions are this record and the upstream root MIT `LICENSE`. The nested ESLint Stylistic license and provenance remain intact. No rules were customized.

## Repository integration

`.oxlintrc.json` enables every generic and Effect rule at error severity, plus native `oxc/no-accumulating-spread`. Effect is a direct repository dependency. `oxlint` and `@oxlint/plugins` are both pinned to `1.82.0`.

`bun run check:oxlint` checks owned extension, library, script, and CLI source and tests. `check`, `lint`, and `verify` include it alongside the existing Biome checks. Explicit source paths avoid loading nested configurations in reference submodules. Installed skills, runtime data, reference checkouts, and this vendored plugin are excluded from application lint.

The service-constructor rule only checks relative project imports, not package or path-alias imports.

## Installation verification

- Compared every copied asset with the pinned upstream bundle. No differences.
- Exercised the configured Oxlint CLI with accepted typed property access, rejected `Reflect.get`, and rejected manual `_tag` comparison. Both plugins produced the expected diagnostics.
- Typechecks and existing Biome checks passed.
- Oxlint reported 1,499 errors and 3 warnings in existing application source and tests, including 1,265 spacing errors. `bun run verify` stops at that lint gate before its test stages.

Source cleanup was not part of installation. No autofixes, suppressions, or severity reductions were applied. Rerun `bun run check:oxlint --format json` for current diagnostics.
