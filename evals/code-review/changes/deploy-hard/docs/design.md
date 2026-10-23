# Design notes

## Terms

- **Artifact**: `APP-VERSION.tar.gz` and its `.sha256`, built by `shipit build`.
- **Version**: the application's version, from the project's `VERSION` file, such as
  `1.4.0`. It names the artifact.
- **Release**: an artifact unpacked on a host under `releases/RELEASE_ID`. The same
  version deployed twice makes two releases.
- **Release id**: the UTC time a deploy started, `YYYYmmddHHMMSS`. Ids sort in deploy
  order, so "newer" and "older" compare ids.
- **Current release**: the release the `current` link points at. It is not always the
  newest: a rollback points `current` at an older release and leaves the newer ones in
  place.
- **Activate**: point `current` at a release. Deploying a release activates it.
- **Rollback**: activate an older release a host already has.
- **Batch**: the hosts a deploy activates together before health-checking them,
  `batch_size` of them, taken in inventory order.

## Rules the scripts rely on

**Activation is atomic.** `current` is replaced by renaming a new link over it
(`mv -T`), never by `ln -sfn` on the live link, so a request on the host sees the old
release or the new one.

**Locks span the whole run.** A command that changes hosts locks every host it will
touch before it changes any, and keeps the locks until it exits. Cleanups, the lock
release among them, are registered with `on_exit`, which owns the only EXIT trap.

**A failed step stops the command.** shipit runs under `set -Eeuo pipefail`. A
multi-step function such as `deploy_host` lists its steps one after another and relies
on errexit to stop at the first one that fails; the ERR trap names the step. Functions
that must survive a failure, like `retry`, test the status themselves.

**A failed deploy is rolled back.** When a host fails a deploy step or a health check,
every host the deploy has activated goes back to its previous release before shipit
exits, and hosts in later batches are left alone. Pruning waits until every batch has
passed, so the releases a rollback needs are still there.

**Pruning keeps the current release.** `prune_releases` keeps the `keep` newest
releases and never deletes the current one, so a host that was rolled back never loses
the release it runs.

**The store token stays out of logs.** `SHIPIT_STORE_TOKEN` reaches only curl's
argument list. Anything that prints a command line passes it through `redact` first.
