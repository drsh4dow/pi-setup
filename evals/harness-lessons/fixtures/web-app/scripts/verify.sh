#!/usr/bin/env bash
# Runs every check CI runs, in order, and stops at the first failure.
set -euo pipefail
cd "$(dirname "$0")/.."

checks=(
  "node --test test/"
  "bash scripts/check-todos.sh"
)

for check in "${checks[@]}"; do
  echo "==> $check"
  eval "$check"
done

echo "All checks passed."
