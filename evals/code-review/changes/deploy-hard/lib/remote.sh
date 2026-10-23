# shellcheck shell=bash
# Host access. Everything shipit does on a host goes through these three functions.

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

ssh_target() {
  local host=$1 user
  user=$(config_get ssh_user)
  if [[ -n $user ]]; then
    printf '%s@%s\n' "$user" "$host"
  else
    printf '%s\n' "$host"
  fi
}

# remote_run HOST CMD [ARG...] — runs CMD on HOST. Every word is quoted, so the remote
# shell sees each argument verbatim. Returns the remote status; 255 means ssh failed.
# --verbose prints the ssh command first.
remote_run() {
  local host=$1 target
  shift
  target=$(ssh_target "$host")
  trace ssh "${SSH_OPTS[@]}" "$target" "$(shell_quote "$@")"
}

# remote_sh HOST SCRIPT [ARG...] — runs SCRIPT with bash on HOST, ARGs as $1, $2, ...
# SCRIPT is shell code written by shipit or by the operator. Never splice a value into
# it; pass the value as an ARG.
remote_sh() {
  local host=$1 script=$2
  shift 2
  remote_run "$host" bash -c "$script" shipit "$@"
}

# remote_copy HOST FILE... DIR — copies FILEs into directory DIR on HOST.
remote_copy() {
  local host=$1 dir=${*: -1} target
  local files=("${@:2:$#-2}")
  target=$(ssh_target "$host")
  trace scp -q "${SSH_OPTS[@]}" "${files[@]}" "$target:$dir"
}
