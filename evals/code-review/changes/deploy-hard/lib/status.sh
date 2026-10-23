# shellcheck shell=bash
# Read-only views of an environment.

# cmd_releases ENV — prints one line per release on each host of ENV:
# HOST RELEASE_ID VERSION current|-   (newest release first, hosts in inventory order)
# VERSION is - for a release deployed before versions were recorded.
cmd_releases() {
  (( $# == 1 )) || die "$E_USAGE" "usage: shipit releases ENV"
  local listing host current version build marker hosts=() versions=()
  listing=$(read_hosts "$1")
  lines_to_array hosts "$listing"
  for host in "${hosts[@]}"; do
    current=$(current_release "$host")
    listing=$(list_releases "$host")
    lines_to_array versions "$listing"
    for version in "${versions[@]}"; do
      build=$(release_version "$host" "$version")
      marker=-
      if [[ $version == "$current" ]]; then
        marker=current
      fi
      printf '%s %s %s %s\n' "$host" "$version" "${build:--}" "$marker"
    done
  done
}
