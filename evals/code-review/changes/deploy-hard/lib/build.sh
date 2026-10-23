# shellcheck shell=bash
# Artifacts: dist/APP-VERSION.tar.gz plus a .sha256 file beside it.

# read_version — the version in the project's VERSION file.
read_version() {
  local file version
  file="$(project_dir)/VERSION"
  [[ -f $file ]] || die "$E_CONFIG" "no VERSION file at $file"
  version=$(tr -d '[:space:]' <"$file")
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "$E_CONFIG" "VERSION: '$version' is not a version"
  printf '%s\n' "$version"
}

# cmd_build — runs build_cmd, packs build_dir into an artifact, and prints its path.
cmd_build() {
  (( $# == 0 )) || die "$E_USAGE" "usage: shipit build"
  local dir app version src name stage build_cmd
  dir=$(project_dir)
  app=$(config_get app)
  version=$(read_version)
  build_cmd=$(config_get build_cmd)
  if [[ -n $build_cmd ]]; then
    log_info "running build_cmd: $build_cmd"
    (cd "$dir" && bash -c "$build_cmd") >&2
  fi
  src="$dir/$(config_get build_dir)"
  [[ -d $src ]] || die "$E_CONFIG" "nothing to pack: $src does not exist"
  name="$app-$version.tar.gz"
  mkdir -p "$dir/dist"
  stage=$(mktemp -d)
  on_exit rm -rf "$stage"
  cp -R "$src/." "$stage/"
  # Fixed names, times, and owners make the same tree produce the same bytes.
  tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$dir/dist/$name" -C "$stage" .
  (cd "$dir/dist" && sha256sum "$name" >"$name.sha256")
  log_info "built $name"
  printf '%s\n' "$dir/dist/$name"
}

# artifact_version ARTIFACT — the version in ARTIFACT's file name.
artifact_version() {
  local name
  name=$(basename "$1" .tar.gz)
  printf '%s\n' "${name#"$(config_get app)"-}"
}

# resolve_artifact [PATH] — PATH when given, otherwise the artifact in dist/ with the
# highest version. Dies unless the artifact and its .sha256 both exist.
resolve_artifact() {
  local path=${1:-} app candidates=() listing
  app=$(config_get app)
  if [[ -z $path ]]; then
    listing=$(find "$(project_dir)/dist" -maxdepth 1 -name "$app-*.tar.gz" 2>/dev/null | sort -V)
    lines_to_array candidates "$listing"
    (( ${#candidates[@]} > 0 )) || die "$E_CONFIG" "no artifact in dist/; run shipit build first"
    path=${candidates[-1]}
  fi
  [[ -f $path ]] || die "$E_CONFIG" "no artifact at $path"
  [[ -f $path.sha256 ]] || die "$E_CONFIG" "no checksum at $path.sha256"
  [[ $(basename "$path") == "$app"-*.tar.gz ]] || die "$E_CONFIG" "$path is not an artifact of $app"
  printf '%s\n' "$path"
}
