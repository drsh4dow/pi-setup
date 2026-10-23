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
| `batch_size` | `1` | Hosts deployed together; `--batch-size` overrides it. |
| `build_cmd` | (none) | Shell command `shipit build` runs in the project first. |
| `build_dir` | `build` | Directory packed into the artifact. |
| `deploy_root` | `/srv/app` | Absolute path on each host that holds the releases. |
| `health_attempts` | `10` | Tries of `health_cmd` before a host counts as unhealthy. |
| `health_cmd` | (none) | Shell command run on each host after it is activated; exit 0 means healthy. |
| `health_interval` | `5` | Seconds between tries of `health_cmd`. |
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

`shipit deploy ENV [ARTIFACT] [--batch-size N]` deploys the artifact (by default the
highest version in `dist/`) to every host of ENV as one new release, named by the UTC
time the deploy started. shipit locks every host first, then deploys the hosts in
batches of N, in inventory order: on each host it copies the artifact over, checks its
checksum, unpacks it under `releases/RELEASE_ID`, records its version, and points
`current` at it. Once every batch has passed, each host is pruned down to `keep`
releases. See [Batches and health checks](#batches-and-health-checks).

`shipit rollback ENV [--to RELEASE_ID]` points every host of ENV at RELEASE_ID, or at
each host's previous release: the newest release older than its current one. It checks
every host before switching any.

`shipit releases ENV` prints `HOST RELEASE_ID VERSION current|-` for each release on
each host, newest release first. VERSION is `-` for releases deployed before shipit
recorded versions.

`-v` or `--verbose`, before the command, prints each ssh, scp, and curl command shipit
runs.

## Batches and health checks

A deploy goes out `batch_size` hosts at a time. After a batch is activated, shipit runs
`health_cmd` on each of its hosts, up to `health_attempts` times, `health_interval`
seconds apart, and starts the next batch only when every host in this one has passed.
Without `health_cmd`, a host counts as healthy once it is activated.

If a host fails a deploy step or its health check, shipit stops, points every host it
has activated in this deploy back at its previous release, and exits 5. Hosts in later
batches are not touched, and nothing is pruned.

Together, batches and health checks make a deploy all-or-nothing: either every host ends
up on the new release, or every host is back exactly where it started, and a broken
release never reaches more than one batch. This keeps deploys predictable at any size of
environment.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | A build, upload, or host step failed. |
| 2 | Bad command line. |
| 3 | Missing or invalid config, inventory, or artifact. |
| 4 | Another shipit run holds a host's lock. |
| 5 | A deploy failed and the hosts it had activated were rolled back. |

## On the hosts

See [docs/layout.md](docs/layout.md) for what shipit keeps under `deploy_root`, and
[docs/design.md](docs/design.md) for the rules the scripts rely on.

## Development

```bash
./test/run.sh
shellcheck -x bin/shipit test/run.sh test/test_*.sh test/stubs/*
```

The tests run against fake hosts in a temporary directory; see `test/lib.sh`.
