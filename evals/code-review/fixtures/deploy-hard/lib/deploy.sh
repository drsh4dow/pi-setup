# shellcheck shell=bash
# Deploys: put an artifact on every host of an environment and activate it.

# cmd_deploy ENV [ARTIFACT] — deploys ARTIFACT (default: the newest in dist/) to every
# host of ENV as one new release.
cmd_deploy() {
  (( $# >= 1 && $# <= 2 )) || die "$E_USAGE" "usage: shipit deploy ENV [ARTIFACT]"
  local env=$1 artifact release listing host hosts=()
  artifact=$(resolve_artifact "${2:-}")
  listing=$(read_hosts "$env")
  lines_to_array hosts "$listing"
  release=$(now_release_id)
  lock_hosts "${hosts[@]}"
  # Hosts go one at a time, in inventory order. A failed step stops the deploy there:
  # hosts before it keep the new release, hosts after it are not touched.
  for host in "${hosts[@]}"; do
    deploy_host "$host" "$artifact" "$release"
  done
  log_info "deployed $(basename "$artifact") to ${#hosts[@]} host(s) in $env as release $release"
}

# deploy_host HOST ARTIFACT RELEASE — uploads ARTIFACT to HOST, checks it against its
# checksum, unpacks it as RELEASE, activates RELEASE, and prunes old releases.
deploy_host() {
  local host=$1 artifact=$2 release=$3 root name
  root=$(config_get deploy_root)
  name=$(basename "$artifact")
  check_layout "$host"
  remote_run "$host" mkdir -p "$root/artifacts" "$root/releases"
  remote_copy "$host" "$artifact" "$artifact.sha256" "$root/artifacts/"
  remote_sh "$host" 'cd "$1" && sha256sum --check --status "$2.sha256"' "$root/artifacts" "$name"
  # Unpack beside the final name and rename, so releases/RELEASE is whole or absent.
  remote_sh "$host" 'mkdir "$2.partial" && tar -xzf "$1" -C "$2.partial" && mv "$2.partial" "$2"' \
    "$root/artifacts/$name" "$root/releases/$release"
  log_info "$host: activating $release"
  activate_release "$host" "$release"
  prune_releases "$host" "$(config_get keep)"
}
