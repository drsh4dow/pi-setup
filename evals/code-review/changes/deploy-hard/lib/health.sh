# shellcheck shell=bash
# Health checks: health_cmd, run on a host once a deploy has activated a release there.

# wait_healthy HOST — runs health_cmd on HOST until it succeeds, up to health_attempts
# times, health_interval seconds apart. Succeeds at once when health_cmd is unset.
wait_healthy() {
  local host=$1 cmd attempts interval try=1
  cmd=$(config_get health_cmd)
  if [[ -z $cmd ]]; then
    return 0
  fi
  attempts=$(config_get health_attempts)
  interval=$(config_get health_interval)
  until remote_sh "$host" "$cmd"; do
    if (( try >= attempts )); then
      log_error "$host: unhealthy after $attempts attempt(s)"
      return 1
    fi
    log_warn "$host: not healthy yet (attempt $try of $attempts), checking again in ${interval}s"
    sleep "$interval"
    try=$((try + 1))
  done
  log_info "$host: healthy"
}
