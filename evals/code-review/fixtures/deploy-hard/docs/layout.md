# Host layout

shipit owns everything under `deploy_root` on a host:

```text
.shipit-layout          layout version of the shipit that last wrote the host
.lock/owner             present while a run holds the host's lock
artifacts/APP-VERSION.tar.gz, .sha256
releases/RELEASE_ID/    one unpacked artifact per release
current -> releases/RELEASE_ID
```

The current layout version is 2 (`LAYOUT_VERSION` in lib/releases.sh).

## Versioning rule

Any change to what shipit writes under `deploy_root` bumps `LAYOUT_VERSION`: a new file
or directory (including one inside a release), a renamed or moved one, or a new format
for an existing one. This holds even when an older shipit would ignore the new file,
because the version is what tells an operator, and `check_layout`, which shipit last
wrote a host. A bump comes with:

- an `upgrade_layout` step from the previous version, even an empty one, so hosts
  upgrade in place on their next deploy;
- a section below saying what changed.

`check_layout` refuses a host stamped with a newer version than its own, so an old
shipit never prunes or rolls back a host whose files it does not know.

## Versions

### 2

Artifacts moved from `deploy_root` into `artifacts/`. The upgrade moves them.

### 1

The first layout: artifacts in `deploy_root`, releases in `releases/`, the
`current` link.
