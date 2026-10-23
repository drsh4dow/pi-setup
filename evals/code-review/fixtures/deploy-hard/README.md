# shipit

shipit builds an artifact from a project, uploads it to an artifact store, deploys it
to the hosts of an environment over ssh, and rolls hosts back to an older release. It
is a handful of bash scripts with no dependencies beyond bash 4.4, GNU tar,
`sha256sum`, `ssh`, `scp`, and `curl`.

## Projects

shipit works on the project whose `shipit.conf` is in the current directory (or at
`$SHIPIT_CONFIG`). Beside it:

- `VERSION`: the version being built, such as `1.4.0`.
- the build output, `build/` unless `build_dir` says otherwise.
- `dist/`: artifacts shipit builds.
- `hosts/ENV.hosts`: the inventory of environment ENV, one host per line, in the order
  shipit deploys them. Blank lines and `#` comments are skipped.

## Config

`shipit.conf` holds `KEY=VALUE` lines; `#` starts a comment line. Unknown keys are an
error. See `shipit.conf.example`.

| Key | Default | Meaning |
| --- | --- | --- |
| `app` | (required) | Lowercase app name; artifacts are `APP-VERSION.tar.gz`. |
| `build_cmd` | (none) | Shell command `shipit build` runs in the project first. |
| `build_dir` | `build` | Directory packed into the artifact. |
| `deploy_root` | `/srv/app` | Absolute path on each host that holds the releases. |
| `keep` | `5` | Releases kept on each host after a deploy. |
| `ssh_user` | (none) | User for ssh and scp; the ssh config decides when unset. |
| `store_url` | (none) | Base URL of the artifact store, needed by `shipit upload`. |

`SHIPIT_STORE_TOKEN` holds the store's bearer token. It is read from the environment
only, never from `shipit.conf`.

## Commands

`shipit build` runs `build_cmd`, packs `build_dir` into `dist/APP-VERSION.tar.gz`, writes
its `.sha256` beside it, and prints the artifact's path. Builds are reproducible: the
same tree gives the same bytes.

`shipit upload [ARTIFACT]` PUTs the artifact and its checksum to `STORE_URL/APP/`,
retrying each upload up to three times.

`shipit deploy ENV [ARTIFACT]` deploys the artifact (by default the highest version in
`dist/`) to every host of ENV as one new release, named by the UTC time the deploy
started. shipit locks every host first, then goes through the hosts in inventory order:
it copies the artifact over, checks its checksum, unpacks it under
`releases/RELEASE_ID`, points `current` at it, and prunes the host down to `keep`
releases. A failed step stops the deploy at that host.

`shipit rollback ENV [--to RELEASE_ID]` points every host of ENV at RELEASE_ID, or at
each host's previous release: the newest release older than its current one. It checks
every host before switching any.

`shipit releases ENV` prints `HOST RELEASE_ID current|-` for each release on each host,
oldest release first.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | A build, upload, or host step failed. |
| 2 | Bad command line. |
| 3 | Missing or invalid config, inventory, or artifact. |
| 4 | Another shipit run holds a host's lock. |

## On the hosts

See [docs/layout.md](docs/layout.md) for what shipit keeps under `deploy_root`, and
[docs/design.md](docs/design.md) for the rules the scripts rely on.

## Development

```bash
./test/run.sh
shellcheck -x bin/shipit test/run.sh test/test_*.sh test/stubs/*
```

The tests run against fake hosts in a temporary directory; see `test/lib.sh`.
