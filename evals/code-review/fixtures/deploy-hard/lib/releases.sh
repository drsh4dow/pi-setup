# shellcheck shell=bash
# Releases on a host. The layout under deploy_root (docs/layout.md):
#
#   .shipit-layout        the layout version that last wrote this host
#   artifacts/            uploaded artifacts and their .sha256 files
#   releases/ID/          one unpacked artifact per release id
#   current -> releases/ID
#
# list_releases prints ids oldest first; callers wanting the newest take the tail.

readonly LAYOUT_VERSION=2

# check_layout HOST — makes sure HOST is at LAYOUT_VERSION: stamps a fresh host,
# upgrades an older layout in place, and dies on a layout newer than this shipit.
check_layout() {
  local host=$1 root found
  root=$(config_get deploy_root)
  found=$(remote_sh "$host" 'cat "$1/.shipit-layout" 2>/dev/null || true' "$root")
  if [[ -z $found ]]; then
    stamp_layout "$host" "$LAYOUT_VERSION"
    return 0
  fi
  [[ $found =~ ^[0-9]+$ ]] || die "$E_STEP" "$host: unreadable layout version '$found'"
  if (( found > LAYOUT_VERSION )); then
    die "$E_STEP" "$host: layout $found was written by a newer shipit (this one writes $LAYOUT_VERSION)"
  fi
  while (( found < LAYOUT_VERSION )); do
    upgrade_layout "$host" "$found"
    found=$((found + 1))
    stamp_layout "$host" "$found"
  done
}

stamp_layout() {
  remote_sh "$1" 'mkdir -p "$1" && printf "%s\n" "$2" > "$1/.shipit-layout"' "$(config_get deploy_root)" "$2"
}

# upgrade_layout HOST FROM — moves HOST from layout FROM to FROM+1.
upgrade_layout() {
  local host=$1 from=$2 root
  root=$(config_get deploy_root)
  case $from in
    1)
      # Layout 1 kept artifacts in deploy_root itself.
      remote_sh "$host" 'cd "$1" && mkdir -p artifacts && for f in ./*.tar.gz ./*.tar.gz.sha256; do if [[ -e $f ]]; then mv "$f" artifacts/; fi; done' "$root"
      ;;
    *) die "$E_STEP" "$host: no upgrade from layout $from" ;;
  esac
  log_info "$host: upgraded layout $from to $((from + 1))"
}

# list_releases HOST — prints HOST's release ids, oldest first.
list_releases() {
  local host=$1 root listing id ids=()
  root=$(config_get deploy_root)
  listing=$(remote_sh "$host" 'ls -1 "$1/releases" 2>/dev/null || true' "$root")
  lines_to_array ids "$listing"
  for id in "${ids[@]}"; do
    if is_release_id "$id"; then
      printf '%s\n' "$id"
    fi
  done | sort
}

# current_release HOST — prints the id current points at; nothing on a fresh host.
current_release() {
  local root target
  root=$(config_get deploy_root)
  target=$(remote_sh "$1" 'readlink "$1/current" || true' "$root")
  if [[ -n $target ]]; then
    printf '%s\n' "${target##*/}"
  fi
}

# previous_release HOST — the newest release older than the current one; nothing
# when there is none.
previous_release() {
  local host=$1 current listing id prev="" ids=()
  current=$(current_release "$host")
  listing=$(list_releases "$host")
  lines_to_array ids "$listing"
  for id in "${ids[@]}"; do
    if [[ $id < $current ]]; then
      prev=$id
    fi
  done
  if [[ -n $prev ]]; then
    printf '%s\n' "$prev"
  fi
}

# release_exists HOST ID — succeeds when HOST has release ID unpacked.
release_exists() {
  remote_run "$1" test -d "$(config_get deploy_root)/releases/$2"
}

# activate_release HOST ID — points current at release ID. The new link is made
# beside current and renamed over it, so a reader sees the old release or the new
# one, never a missing link.
activate_release() {
  remote_sh "$1" 'test -d "$1/releases/$2" && ln -sfn "releases/$2" "$1/.current.tmp" && mv -T "$1/.current.tmp" "$1/current"' \
    "$(config_get deploy_root)" "$2"
}

# prune_releases HOST KEEP — deletes all but the KEEP newest releases. The current
# release is never deleted, even when it is older than those.
prune_releases() {
  local host=$1 keep=$2 root current listing i doomed=() ids=()
  root=$(config_get deploy_root)
  current=$(current_release "$host")
  listing=$(list_releases "$host")
  lines_to_array ids "$listing"
  for (( i = 0; i < ${#ids[@]} - keep; i++ )); do
    if [[ ${ids[i]} != "$current" ]]; then
      doomed+=("${ids[i]}")
    fi
  done
  if (( ${#doomed[@]} == 0 )); then
    return 0
  fi
  remote_sh "$host" 'cd "$1/releases" && shift && rm -rf -- "$@"' "$root" "${doomed[@]}"
  log_info "$host: pruned ${#doomed[@]} old release(s)"
}
