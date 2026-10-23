# shellcheck shell=bash
# Rollbacks: point an environment's hosts back at a release they already have.

# cmd_rollback ENV [--to ID] — activates release ID on every host of ENV; without --to,
# each host's previous release (the newest one older than its current release).
cmd_rollback() {
  local env="" to="" listing host target hosts=() targets=() i
  while (( $# > 0 )); do
    case $1 in
      --to)
        (( $# >= 2 )) || die "$E_USAGE" "--to needs a release id"
        to=$2
        shift 2
        ;;
      -*) die "$E_USAGE" "unknown flag $1" ;;
      *)
        [[ -z $env ]] || die "$E_USAGE" "usage: shipit rollback ENV [--to ID]"
        env=$1
        shift
        ;;
    esac
  done
  [[ -n $env ]] || die "$E_USAGE" "usage: shipit rollback ENV [--to ID]"
  if [[ -n $to ]]; then
    is_release_id "$to" || die "$E_USAGE" "'$to' is not a release id"
  fi
  listing=$(read_hosts "$env")
  lines_to_array hosts "$listing"
  lock_hosts "${hosts[@]}"
  # Pick and check every host's target before switching any host, so a rollback that
  # cannot finish leaves the environment as it was.
  for host in "${hosts[@]}"; do
    target=$to
    if [[ -z $target ]]; then
      target=$(previous_release "$host")
      [[ -n $target ]] || die "$E_STEP" "$host: no release older than the current one"
    fi
    release_exists "$host" "$target" || die "$E_STEP" "$host: no release $target"
    targets+=("$target")
  done
  for i in "${!hosts[@]}"; do
    rollback_host "${hosts[i]}" "${targets[i]}"
  done
}

# rollback_host HOST ID — activates release ID, which HOST must already have. Shared by
# shipit rollback and the automatic rollback of a failed deploy (lib/batch.sh).
rollback_host() {
  local host=$1 id=$2
  if ! release_exists "$host" "$id"; then
    log_error "$host: no release $id"
    return 1
  fi
  activate_release "$host" "$id"
  log_info "$host: rolled back to $id"
}
