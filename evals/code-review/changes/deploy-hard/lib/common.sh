# shellcheck shell=bash
# Shared helpers: exit codes, logging, running commands, cleanup on exit.

# Exit codes. README.md lists them for operators; keep the two in step.
readonly E_STEP=1    # a build, upload, or host step failed
readonly E_USAGE=2   # bad command line
readonly E_CONFIG=3  # missing or invalid config, inventory, or artifact
readonly E_LOCKED=4  # another shipit run holds a host's lock
readonly E_ROLLED_BACK=5  # a deploy failed and its hosts were rolled back

# 1 under --verbose: print each external command before running it.
SHIPIT_VERBOSE=0

log_info() { printf 'shipit: %s\n' "$*" >&2; }
log_warn() { printf 'shipit: warning: %s\n' "$*" >&2; }
log_error() { printf 'shipit: error: %s\n' "$*" >&2; }

# die [CODE] MESSAGE... — logs MESSAGE and exits with CODE (default E_STEP).
die() {
  local code=$E_STEP
  if [[ $1 =~ ^[0-9]+$ ]]; then
    code=$1
    shift
  fi
  log_error "$*"
  exit "$code"
}

# shipit_failed STATUS COMMAND — the ERR trap. Reports the step that stopped shipit;
# errexit then exits with that step's status.
shipit_failed() {
  if (( BASH_SUBSHELL == 0 )); then
    log_error "step failed (exit $1): $(redact "$2")"
  fi
}

# shell_quote ARG... — prints ARGs quoted for bash, space separated.
shell_quote() {
  local quoted
  printf -v quoted '%q ' "$@"
  printf '%s' "${quoted% }"
}

# redact TEXT — masks bearer tokens and token= query values. Anything that may print
# a command line passes it through here first.
redact() {
  sed -E 's/(Bearer )[^ "]+/\1***/g; s/(token=)[^ &"]+/\1***/g' <<<"$1"
}

# command_line CMD... — CMD quoted so it can be pasted into a shell, passed through
# redact.
command_line() {
  redact "$(shell_quote "$@")"
}

# trace CMD... — runs CMD, printing it first under --verbose. Returns CMD's status.
trace() {
  if [[ $SHIPIT_VERBOSE == 1 ]]; then
    log_info "+ $(command_line "$@")"
  fi
  "$@"
}

# run CMD... — runs CMD through trace. On failure logs the command, redacted, and
# returns its status.
run() {
  local status=0
  trace "$@" || status=$?
  if (( status != 0 )); then
    log_error "command failed (exit $status): $(redact "$*")"
  fi
  return "$status"
}

# retry ATTEMPTS DELAY CMD... — runs CMD until it succeeds, at most ATTEMPTS times,
# sleeping DELAY seconds between tries. Returns CMD's last status.
retry() {
  local attempts=$1 delay=$2 try=1 status
  shift 2
  while true; do
    status=0
    "$@" || status=$?
    if (( status == 0 )); then
      return 0
    fi
    if (( try >= attempts )); then
      return "$status"
    fi
    log_warn "attempt $try of $attempts failed (exit $status), retrying in ${delay}s"
    sleep "$delay"
    try=$((try + 1))
  done
}

SHIPIT_EXIT_HOOKS=()

# on_exit CMD... — runs CMD when shipit exits, however it exits. Hooks run newest
# first. This is the only EXIT trap: register cleanups here instead of calling trap.
on_exit() {
  SHIPIT_EXIT_HOOKS+=("$(shell_quote "$@")")
  trap shipit_run_exit_hooks EXIT
}

shipit_run_exit_hooks() {
  local i
  for (( i = ${#SHIPIT_EXIT_HOOKS[@]} - 1; i >= 0; i-- )); do
    eval "${SHIPIT_EXIT_HOOKS[i]}" || log_warn "cleanup failed: ${SHIPIT_EXIT_HOOKS[i]}"
  done
}

# now_release_id — the id of a release made now: the UTC time as YYYYmmddHHMMSS, so
# ids sort in deploy order. SHIPIT_NOW overrides the clock.
now_release_id() {
  if [[ -n ${SHIPIT_NOW:-} ]]; then
    printf '%s\n' "$SHIPIT_NOW"
  else
    date -u +%Y%m%d%H%M%S
  fi
}

# is_release_id TEXT — succeeds when TEXT has the shape of a release id.
is_release_id() {
  [[ $1 =~ ^[0-9]{14}$ ]]
}

# lines_to_array NAME TEXT — splits TEXT into the array NAME, one element per
# non-empty line. Use it on captured output instead of mapfile < <(...), which
# hides the producer's failure.
lines_to_array() {
  local -n lines_out=$1
  local line
  lines_out=()
  while IFS= read -r line; do
    if [[ -n $line ]]; then
      lines_out+=("$line")
    fi
  done <<<"$2"
}
