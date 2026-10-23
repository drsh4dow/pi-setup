#!/usr/bin/env bash
# Runs every test/test_*.sh, or the test files given. Exits 1 if any test fails.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

files=("$@")
if (( ${#files[@]} == 0 )); then
  files=(test/test_*.sh)
fi

results=$(mktemp)
trap 'rm -f "$results"' EXIT
export TEST_RESULTS=$results

for file in "${files[@]}"; do
  printf '%s\n' "$file"
  bash "$file"
done

passed=$(grep -c '^ok' "$results")
failed=$(grep -c '^FAIL' "$results")
printf '\n%s passed, %s failed\n' "$passed" "$failed"
grep '^FAIL' "$results"
(( failed == 0 ))
