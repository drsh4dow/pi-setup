#!/bin/sh
# Source files under src/ carry no comments.
set -eu
if grep -rnE '^\s*(//|/\*|\*)' src; then
  echo "check: comments in src/; document exports in README.md instead" >&2
  exit 1
fi
