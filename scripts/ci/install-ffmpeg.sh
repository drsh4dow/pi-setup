#!/usr/bin/env bash
# Put a pinned static ffmpeg and ffprobe in <dir> and on the CI job's PATH, so a job never waits
# on the Ubuntu apt mirror for them. The workflows cache <dir> under a key that hashes this file,
# so changing the pin below starts a fresh cache.
# Usage: scripts/ci/install-ffmpeg.sh <dir>
set -euo pipefail

dir=${1:?usage: install-ffmpeg.sh <dir>}
# BtbN keeps the last build of each month; a daily build is deleted within weeks.
url=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1.tar.xz
sha256=97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79

if [[ -x $dir/ffmpeg && -x $dir/ffprobe ]]; then
  echo "ffmpeg restored from the cache in $dir"
else
  echo "Downloading $url"
  mkdir -p "$dir"
  archive=$(mktemp)
  curl --fail --silent --show-error --location --retry 3 --output "$archive" "$url"
  echo "$sha256  $archive" | sha256sum --check --quiet
  tar --extract --xz --file "$archive" --directory "$dir" --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'
  rm "$archive"
fi
echo "$dir" >> "$GITHUB_PATH"
"$dir/ffmpeg" -hide_banner -version | sed -n 1p
