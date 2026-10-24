#!/usr/bin/env bash
# Fails on a TODO in src/ that names no issue, such as "TODO(#123)".
set -euo pipefail
cd "$(dirname "$0")/.."

if grep -rnE 'TODO($|[^(]|\([^#])' src/; then
  echo "TODOs above need an issue reference, like TODO(#123)."
  exit 1
fi
