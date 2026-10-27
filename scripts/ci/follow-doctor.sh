#!/usr/bin/env bash
# Follows SETUP.md's verify loop without judgement: run the doctor, run the fix under each FAIL,
# and repeat, at most three rounds. Exits with the last doctor's code, so 0 means a setup that
# an agent following SETUP.md would finish. CI runs it after mise run setup.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

for round in 1 2 3; do
  echo "follow-doctor: round $round"
  output="$(mise run doctor 2>&1)"
  status=$?
  echo "$output"
  if [ "$status" -ne 1 ]; then exit "$status"; fi

  # A fix line belongs to the finding above it; only fixes under a FAIL run.
  fixes="$(awk '/^[A-Za-z]/ { failing = ($1 == "FAIL") } failing && /^      fix: / { sub(/^      fix: /, ""); print }' <<<"$output")"
  if [ -z "$fixes" ]; then
    echo "follow-doctor: a check fails with no fix to run" >&2
    exit 1
  fi

  while IFS= read -r fix; do
    echo "follow-doctor: running $fix"
    bash -c "$fix" || echo "follow-doctor: the fix exited $?" >&2
  done <<<"$fixes"
done

echo "follow-doctor: the doctor still fails after three rounds of fixes" >&2
mise run doctor
exit 1
