# shellcheck shell=bash
# Deploys: put an artifact on every host of an environment and activate it.

DEPLOY_USAGE="usage: shipit deploy ENV [ARTIFACT] [--batch-size N]"

# cmd_deploy ENV [ARTIFACT] [--batch-size N] — deploys ARTIFACT (default: the newest in
# dist/) to every host of ENV as one new release, N hosts at a time (lib/batch.sh).
# Hosts are pruned once every batch has passed.
cmd_deploy() {
  local env="" artifact="" size release listing host hosts=()
  size=$(config_get batch_size)
  while (( $# > 0 )); do
    case $1 in
      --batch-size)
        (( $# >= 2 )) || die "$E_USAGE" "--batch-size needs a number"
        size=$2
        shift 2
        ;;
      -*) die "$E_USAGE" "unknown flag $1" ;;
      *)
        if [[ -z $env ]]; then
          env=$1
        elif [[ -z $artifact ]]; then
          artifact=$1
        else
          die "$E_USAGE" "$DEPLOY_USAGE"
        fi
        shift
        ;;
    esac
  done
  [[ -n $env ]] || die "$E_USAGE" "$DEPLOY_USAGE"
  [[ $size =~ ^[1-9][0-9]*$ ]] || die "$E_USAGE" "--batch-size must be a positive integer, got '$size'"
  artifact=$(resolve_artifact "$artifact")
  listing=$(read_hosts "$env")
  lines_to_array hosts "$listing"
  release=$(now_release_id)
  lock_hosts "${hosts[@]}"
  deploy_in_batches "$artifact" "$release" "$size" "${hosts[@]}"
  for host in "${hosts[@]}"; do
    prune_releases "$host" "$(config_get keep)"
  done
  log_info "deployed $(basename "$artifact") to ${#hosts[@]} host(s) in $env as release $release"
}

# deploy_host HOST ARTIFACT RELEASE — uploads ARTIFACT to HOST, checks it against its
# checksum, unpacks it as RELEASE, records its version, and activates RELEASE.
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
  write_release_meta "$host" "$release" "$(artifact_version "$artifact")"
  log_info "$host: activating $release"
  activate_release "$host" "$release"
}
