# shellcheck shell=bash
# Inventories: hosts/ENV.hosts in the project, one host per line, in deploy order.
# Blank lines and # comments are skipped.

# read_hosts ENV — prints ENV's hosts, one per line, in inventory order.
read_hosts() {
  local env=$1 file line n=0 count=0
  [[ $env =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "$E_USAGE" "invalid environment name '$env'"
  file="$(project_dir)/hosts/$env.hosts"
  [[ -f $file ]] || die "$E_CONFIG" "no inventory for $env at $file"
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line=${line%%#*}
    line=${line//[[:space:]]/}
    if [[ -z $line ]]; then
      continue
    fi
    # A leading dash would reach ssh as an option.
    [[ $line =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "$E_CONFIG" "$file:$n: invalid host '$line'"
    printf '%s\n' "$line"
    count=$((count + 1))
  done <"$file"
  (( count > 0 )) || die "$E_CONFIG" "$file lists no hosts"
}
