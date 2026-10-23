# shellcheck shell=bash
# Host locks. A run that changes hosts takes the lock on every host it will touch
# before changing any of them, and holds the locks until it exits.

readonly LOCK_HELD=75

# acquire_lock HOST — takes HOST's lock, or dies with E_LOCKED when another run holds
# it. The lock is released when shipit exits.
acquire_lock() {
  local host=$1 root status=0
  root=$(config_get deploy_root)
  remote_sh "$host" 'mkdir -p "$1" && { mkdir "$1/.lock" 2>/dev/null || exit "$2"; } && printf "%s\n" "$3" > "$1/.lock/owner"' \
    "$root" "$LOCK_HELD" "${USER:-unknown}@$(hostname) pid $$" || status=$?
  case $status in
    0) on_exit release_lock "$host" ;;
    "$LOCK_HELD") die "$E_LOCKED" "$host is locked by another shipit run (see $root/.lock/owner)" ;;
    *) die "$E_STEP" "$host: cannot take the lock (exit $status)" ;;
  esac
}

release_lock() {
  remote_run "$1" rm -rf "$(config_get deploy_root)/.lock"
}

# lock_hosts HOST... — takes the lock on every HOST, in order.
lock_hosts() {
  local host
  for host in "$@"; do
    acquire_lock "$host"
  done
}
