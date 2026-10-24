#!/bin/sh
# Migrations on main are immutable: only new files may appear under migrations/.
set -eu
touched=$(git diff --name-only --diff-filter=MDR "$BASE" -- migrations)
if [ -n "$touched" ]; then
  echo "check: existing migrations changed: $touched; add a new numbered migration instead" >&2
  exit 1
fi
