# Contributing

Run `./test/run.sh` and `shellcheck -x bin/shipit test/run.sh test/test_*.sh test/stubs/*`
before sending a change. Both must pass. Beyond that, reviewers check these rules:

1. **Hosts only through lib/remote.sh.** Every command shipit runs on a host goes
   through `remote_run`, `remote_sh`, or `remote_copy`. Values reach the remote shell
   as arguments, never spliced into a script string.
2. **Config keys are declared and documented.** Every key has its default in
   `CONFIG_DEFAULTS` (lib/config.sh), is validated in `validate_config` when it has a
   shape, and has a row in the README's config table.
3. **Host layout changes are versioned.** A change to what shipit writes under
   `deploy_root` bumps `LAYOUT_VERSION` in lib/releases.sh, adds an `upgrade_layout`
   step, and gets a section in docs/layout.md. See that file for what counts.
4. **Exit codes and output.** Commands exit with the `E_*` codes from lib/common.sh,
   and every code is listed in the README. Progress and errors go to stderr through
   `log_info`, `log_warn`, and `log_error`; stdout carries only what a script would
   parse (the artifact path from `build`, the table from `releases`).
