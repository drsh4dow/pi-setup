# shellcheck shell=bash
# Read-only views of an environment.

# cmd_releases ENV — prints one line per release on each host of ENV:
# HOST RELEASE_ID current|-   (oldest release first, hosts in inventory order)
cmd_releases() {
  (( $# == 1 )) || die "$E_USAGE" "usage: shipit releases ENV"
  local listing host current id hosts=() ids=()
  listing=$(read_hosts "$1")
  lines_to_array hosts "$listing"
  for host in "${hosts[@]}"; do
    current=$(current_release "$host")
    listing=$(list_releases "$host")
    lines_to_array ids "$listing"
    for id in "${ids[@]}"; do
      if [[ $id == "$current" ]]; then
        printf '%s %s current\n' "$host" "$id"
      else
        printf '%s %s -\n' "$host" "$id"
      fi
    done
  done
}
