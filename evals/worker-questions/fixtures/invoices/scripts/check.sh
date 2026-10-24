#!/bin/sh
# The gate CI runs on every pull request: the tests, then the repository rules in AGENTS.md.
set -eu
cd "$(dirname "$0")/.."

node --test test/

base=$(git merge-base HEAD main 2>/dev/null || echo main)

for rule in scripts/rules/*.sh; do
  [ -e "$rule" ] || continue
  BASE="$base" sh "$rule"
done

echo "check: ok"
