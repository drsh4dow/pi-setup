# shellcheck shell=bash
# Batched deploys. Hosts go out batch_size at a time, in inventory order. Each batch is
# deployed and health-checked before the next one starts, and a failure anywhere rolls
# back every host the deploy has activated so far.

# deploy_in_batches ARTIFACT RELEASE SIZE HOST... — deploys RELEASE to HOSTs, SIZE at a
# time. When a host fails a step or its health check, every host activated so far goes
# back to its previous release and shipit exits with E_ROLLED_BACK.
deploy_in_batches() {
  local artifact=$1 release=$2 size=$3
  shift 3
  local hosts=("$@") activated=() batch=() host start count
  count=$(( (${#hosts[@]} + size - 1) / size ))
  for (( start = 0; start < ${#hosts[@]}; start += size )); do
    batch=("${hosts[@]:start:size}")
    log_info "batch $(( start / size + 1 )) of $count: ${batch[*]}"
    for host in "${batch[@]}"; do
      if ! deploy_host "$host" "$artifact" "$release"; then
        roll_back_deploy "$host: deploy failed" "${activated[@]}"
      fi
      activated+=("$host")
    done
    for host in "${batch[@]}"; do
      if ! wait_healthy "$host"; then
        roll_back_deploy "$host: health check failed" "${activated[@]}"
      fi
    done
  done
}

# roll_back_deploy REASON HOST... — activates each HOST's previous release, then exits
# with E_ROLLED_BACK. A host with no previous release keeps the new one.
roll_back_deploy() {
  local reason=$1 host target failed=()
  shift
  log_error "$reason; rolling back $# host(s)"
  for host in "$@"; do
    target=$(previous_release "$host")
    if [[ -z $target ]]; then
      log_warn "$host: no previous release, leaving it on the new one"
      continue
    fi
    rollback_host "$host" "$target" || failed+=("$host")
  done
  if (( ${#failed[@]} > 0 )); then
    log_error "could not roll back: ${failed[*]}"
  fi
  exit "$E_ROLLED_BACK"
}
