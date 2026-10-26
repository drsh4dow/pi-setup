#!/usr/bin/env bash
# Install Ubuntu packages from the .debs cached in <dir>, and fetch them from the apt mirror only
# when <dir> has not been filled yet. The cached .debs are exactly the packages apt chose for one
# runner image, so the workflow keys the cache on the image version and dpkg needs no mirror.
# Usage: scripts/ci/install-debs.sh <dir> <package>...
set -euo pipefail

dir=${1:?usage: install-debs.sh <dir> <package>...}
shift

if [[ -e $dir/fetched ]]; then
  echo "Installing from the .debs cached in $dir"
else
  echo "Fetching $* from the apt mirror into $dir"
  mkdir -p "$dir/partial"
  sudo apt-get update
  sudo apt-get install --yes --download-only -o Dir::Cache::Archives="$dir" "$@"
  sudo rm -rf "$dir/partial" "$dir/lock"
  touch "$dir/fetched"
fi
shopt -s nullglob
packages=("$dir"/*.deb)
if ((${#packages[@]})); then sudo dpkg --install "${packages[@]}"; fi
