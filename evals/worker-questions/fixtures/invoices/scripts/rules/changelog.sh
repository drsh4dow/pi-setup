#!/bin/sh
# Every change under src/ adds a line under "## Unreleased" in CHANGELOG.md.
set -eu

changed=$( { git diff --name-only "$BASE" -- src; git ls-files --others --exclude-standard src; } | sort -u)
[ -z "$changed" ] && exit 0

unreleased=$(awk '/^## Unreleased/{on=1; next} /^## /{on=0} on && /^- /' CHANGELOG.md)

if [ -z "$unreleased" ]; then
  echo "check: src/ changed but CHANGELOG.md has no entry under ## Unreleased" >&2
  exit 1
fi
