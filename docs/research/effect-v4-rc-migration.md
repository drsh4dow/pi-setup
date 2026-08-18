# Effect v4 RC migration research

_Checked 2026-08-17 against first-party npm/GitHub metadata and Effect `main`._

## Decision-ready facts

- The current npm `rc` dist-tag is **`4.0.0-rc.110` for both `effect` and `@effect/platform-bun`**. Use the same exact version for both; v4 releases the ecosystem under one version, and `@effect/platform-bun@4.0.0-rc.110` declares `effect: ^4.0.0-rc.110` as a peer plus `@effect/platform-node-shared: ^4.0.0-rc.110`. The corresponding git tags are **`effect@4.0.0-rc.110`** and **`@effect/platform-bun@4.0.0-rc.110`**, both at commit **`66114151c2b4640bf773f2b3456ce70d679422f6`**. [npm package metadata: effect](https://registry.npmjs.org/effect/4.0.0-rc.110), [npm package metadata: platform-bun](https://registry.npmjs.org/@effect%2fplatform-bun/4.0.0-rc.110), [Effect release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0-rc.110), [git tag refs](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.110)
- Do **not** use npm `latest`: it still identifies the stable v3-era lines (`effect@3.22.1`, `@effect/platform-bun@0.91.2`). Effect's main README explicitly says v4 is an RC, `main` contains v4 development, and installation is `effect@rc`; this repository should pin `4.0.0-rc.110` exactly to keep the two coordinated packages aligned. [Effect README](https://github.com/Effect-TS/effect/blob/main/README.md), [npm dist-tags: effect](https://registry.npmjs.org/-/package/effect/dist-tags), [npm dist-tags: platform-bun](https://registry.npmjs.org/-/package/@effect%2fplatform-bun/dist-tags)
- Current requirements remain compatible with this repository's declared toolchain: Effect requires TypeScript 5.9+, strict type checking, and Node 18+ generally; the repository declares TypeScript 7. [Effect README requirements](https://github.com/Effect-TS/effect/blob/main/README.md#requirements)

## Likely source changes for `agent/extensions`

A targeted scan found imports from the root `effect` barrel, `effect/testing`, `effect/unstable/http`, `effect/unstable/process`, and Bun modules such as `BunFileSystem`, `BunPath`, `BunCrypto`, `BunHttpClient`, `BunHttpServer`, `BunServices`, and `BunChildProcessSpawner`.

1. **One definite compile break:** `agent/extensions/aoauth/oauth.ts` extends `Schema.TaggedErrorClass`. Between beta.102 and the RC this constructor was renamed to **`Schema.TaggedError`** (and `Schema.ErrorClass` to `Schema.Error`; the JavaScript-error schema became `Schema.ErrorInstance`). Change that class to `Schema.TaggedError<OAuthRequestError>()(...)`. [first-party rename commit and diff](https://github.com/Effect-TS/effect/commit/592dd361645739ac0cd8e6babb084cd27403c172), [current LLMS examples](https://github.com/Effect-TS/effect/blob/main/LLMS.md#using-effectgen), [RC Schema source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.110/packages/effect/src/Schema.ts)
2. **No Bun import-path rewrite is indicated.** The platform source directories moved inside the monorepo, but package names and public files remained `@effect/platform-bun/BunFileSystem`, `/BunPath`, etc.; the move commit records these files as renames without source changes. Existing package-level imports should remain. [platform move commit](https://github.com/Effect-TS/effect/commit/c7fa11044c4dcae36ee5a04201ff9c4f4c255ea6), [RC Bun package source](https://github.com/Effect-TS/effect/tree/effect%404.0.0-rc.110/packages/platform/bun/src)
3. **Clock behavior deserves focused tests, not an import change.** The runtime split wall-clock and monotonic semantics after beta.102. This repository calls `Clock.currentTimeMillis` for timestamps and uses `Effect.sleep`/timeouts. Those names remain, but timing-sensitive tests should be run because the underlying semantics changed. [clock change commit](https://github.com/Effect-TS/effect/commit/d0f1a2295155c350b04efb46852cb40032805273), [RC Clock source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.110/packages/effect/src/Clock.ts)
4. **Schema diagnostics changed:** actual input values were removed from schema issues, error constructors were renamed, and `SchemaError` was folded into `Schema`. Code here mostly decodes and maps errors rather than importing `SchemaError`, so the constructor rename above is the observed source break; snapshot/string assertions around parse failures are the residual risk. [remove issue values](https://github.com/Effect-TS/effect/commit/8f9499f562729f5f7b08d8bcc4db86b4aeff8a21), [move SchemaError](https://github.com/Effect-TS/effect/commit/accf4474513064e2a21d14b1937503261b4f34dc)
5. `effect/unstable/http` and `effect/unstable/process` are still the documented locations, but Effect explicitly reserves breaking changes for `unstable/*`; therefore typecheck the HTTP/process-heavy extensions rather than assuming beta compatibility. [migration guide: unstable modules](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md#unstable-module-system), [LLMS child-process guidance](https://github.com/Effect-TS/effect/blob/main/LLMS.md#working-with-child-processes)

The general v3-to-v4 migration pages are useful context but most of their large renames predate beta.102. They should not be applied mechanically to code already on beta.102. [Effect migration index](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)

## Replace `.repos/effect-smol` with `.repos/effect`

The requested submodule approach differs from Effect's article preference: the article recommends a subtree for clone ergonomics, but explicitly says submodules are valid, provide repository separation, and pin a commit. For this repository, pin the submodule to the RC tag commit rather than tracking mutable `main`; agents then read source matching installed dependencies. [first-party article](https://www.effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive), [Git submodule documentation](https://git-scm.com/docs/git-submodule), [gitmodules format](https://git-scm.com/docs/gitmodules)

Planned maintainer commands (not executed during this research task):

```sh
git rm -r .repos/effect-smol
git submodule add https://github.com/effect-ts/effect .repos/effect
git -C .repos/effect checkout effect@4.0.0-rc.110
git add .gitmodules .repos/effect
```

A fresh clone must use `git clone --recurse-submodules ...`, or initialize afterward with `git submodule update --init --recursive`. Updates should be deliberate: fetch in the submodule, check out the chosen Effect tag, then record the new gitlink in the parent. [Git book: cloning and updating submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules)

### Recommended agent instruction

```md
Before writing Effect code, read `.repos/effect/LLMS.md` and inspect
`.repos/effect/packages`, tests, and migration docs for APIs and idioms.
Treat `.repos/effect` as read-only reference source pinned to the installed
Effect release. Do not edit, commit, fetch, checkout, or update the submodule;
do not import application code from it. Continue importing from `effect` and
`@effect/*` package dependencies. If the directory is absent, report that the
submodule needs `git submodule update --init --recursive` rather than guessing
or using a different checkout.
```

This follows Effect's own guidance to make the location and read-only role explicit, prefer local source patterns over guesses, forbid imports from the vendored tree, and read `LLMS.md` before Effect work. [article: configuring the agent](https://www.effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive#configuring-the-agent), [Effect LLMS](https://github.com/Effect-TS/effect/blob/main/LLMS.md)
