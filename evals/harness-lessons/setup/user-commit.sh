#!/usr/bin/env bash
# The user's own commit on main, landing while the agent works: on the agent's first sign of work,
# or after <fallback> seconds, it adds one line to README.md on main and writes {sha, message,
# method, trigger, firedAt} to <record>. It polls every second for a new branch, a new worktree,
# or a change to docs/development.md in the main working tree. It commits
# normally in the worktree that has main checked out when that worktree's README.md is clean,
# and otherwise writes the commit with plumbing, so it lands on main whatever the agent did.
#
#   user-commit.sh <record> <fallback-seconds>
set -euo pipefail

record=$1
fallback=$2
message="README: point contributors at the development guide"
line="Contributors: start with docs/development.md."

branches() { git for-each-ref --format='%(refname)' refs/heads; }
worktrees() { git worktree list --porcelain | grep '^worktree '; }
doc_changed() { ! git diff --quiet HEAD -- docs/development.md; }

start_branches=$(branches)
start_worktrees=$(worktrees)
trigger=fallback

for _ in $(seq "$fallback"); do
  sleep 1

  if [ "$(branches)" != "$start_branches" ]; then trigger=branch; break; fi

  if [ "$(worktrees)" != "$start_worktrees" ]; then trigger=worktree; break; fi

  if doc_changed; then trigger=doc; break; fi
done

# The worktree that has main checked out, if any.
main_worktree=$(git worktree list --porcelain | awk '
  /^worktree / { path = substr($0, 10) }
  /^branch refs\/heads\/main$/ { print path }
')

fired_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
method=plumbing

if [ -n "$main_worktree" ] &&
  git -C "$main_worktree" diff --quiet HEAD -- README.md; then
  for _ in $(seq 60); do
    lock="$(git -C "$main_worktree" rev-parse --absolute-git-dir)/index.lock"

    if [ ! -e "$lock" ]; then
      printf '%s\n' "$line" >> "$main_worktree/README.md"

      if git -C "$main_worktree" commit -q --only -m "$message" -- README.md 2>/dev/null; then
        method=commit
        break
      fi

      # Someone else took the lock between the check and the commit; undo and retry.
      git -C "$main_worktree" checkout -q HEAD -- README.md
    fi

    sleep 0.5
  done
fi

if [ "$method" = plumbing ]; then
  parent=$(git rev-parse refs/heads/main)
  index=$(mktemp)
  GIT_INDEX_FILE=$index git read-tree "$parent"
  blob=$( { git show "$parent:README.md"; printf '%s\n' "$line"; } | git hash-object -w --stdin)
  GIT_INDEX_FILE=$index git update-index --cacheinfo "100644,$blob,README.md"
  tree=$(GIT_INDEX_FILE=$index git write-tree)
  rm -f "$index"
  sha=$(git commit-tree "$tree" -p "$parent" -m "$message")
  git update-ref -m "commit: $message" refs/heads/main "$sha" "$parent"
else
  sha=$(git -C "$main_worktree" rev-parse HEAD)
fi

printf '{"sha":"%s","message":"%s","method":"%s","trigger":"%s","firedAt":"%s"}\n' \
  "$sha" "$message" "$method" "$trigger" "$fired_at" > "$record.tmp"
mv "$record.tmp" "$record"
