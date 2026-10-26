#!/usr/bin/env bash
# Human-in-the-loop reproduction loop.
# Copy this file, edit the steps below, and open it in a pane the user sees,
# as HITL.md describes. The user follows the prompts there.
#
# Usage:
#   bash hitl-loop.sh ANSWERS_FILE
#
# Two helpers:
#   step "<instruction>"          → show instruction, wait for Enter
#   capture VAR "<question>"      → show question, read response into VAR
#
# At the end, captured values are written to ANSWERS_FILE as KEY=VALUE lines
# for the agent to parse. The file appears only once every step is done.
#
# `capture` sends its value to the agent, so capture observations, and leave
# signing in to the user as a `step`.

set -euo pipefail

answers="${1:?usage: $0 ANSWERS_FILE}"
captured=()

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
  captured+=("$var")
}

# --- edit below ---------------------------------------------------------

step "Open the app at http://localhost:3000 and sign in."

capture ERRORED "Click the 'Export' button. Did it throw an error? (y/n)"

capture ERROR_MSG "Paste the error message (or 'none'):"

# --- edit above ---------------------------------------------------------

for var in "${captured[@]}"; do
  printf '%s=%s\n' "$var" "${!var}"
done >"$answers.tmp"
mv "$answers.tmp" "$answers"

printf '\n--- Sent to the agent ---\n'
cat "$answers"
