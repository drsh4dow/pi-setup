#!/usr/bin/env bash
# Follows SETUP.md's verify loop without judgement: run the doctor, run the fix under each FAIL,
# and run the doctor again, stopping when a check still fails after two rounds of fixes. Exits
# with the last doctor's code, so 0 means a setup that an agent following SETUP.md would finish.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

for round in 1 2 3; do
  echo "follow-doctor: round $round"
  output="$(mise run doctor 2>&1)"
  status=$?
  echo "$output"
  if [ "$status" -ne 1 ]; then exit "$status"; fi

  if [ "$round" -eq 3 ]; then
    echo "follow-doctor: a check still fails after two rounds of fixes" >&2
    exit 1
  fi

  # A fix line belongs to the finding above it; only fixes under a FAIL run, each once.
  fixes="$(awk '/^[A-Za-z]/ { failing = ($1 == "FAIL") } failing && /^      fix: / { sub(/^      fix: /, ""); if (!seen[$0]++) print }' <<<"$output")"
  if [ -z "$fixes" ]; then
    echo "follow-doctor: a check fails with no fix to run" >&2
    exit 1
  fi

  while IFS= read -r fix; do
    echo "follow-doctor: running $fix"
    bash -c "$fix" || echo "follow-doctor: the fix exited $?" >&2
  done <<<"$fixes"
done
