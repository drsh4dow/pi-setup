#!/usr/bin/env bash
# The user commits to main on the agent's first sign of work (a new branch or worktree, or an edit
# to docs/development.md here), or 20 seconds from now if none comes first.
set -euo pipefail

setsid nohup bash "$(dirname "$0")/user-commit.sh" "$SETUP_OUTPUT/user-commit.json" \
  "${USER_COMMIT_FALLBACK:-20}" >/dev/null 2>&1 < /dev/null &
