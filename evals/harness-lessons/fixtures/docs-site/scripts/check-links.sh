#!/usr/bin/env bash
# Checks the relative links in the Markdown pages changed on this branch, so a push never
# ships a link to a missing page. Pass paths to check those pages instead.
set -uo pipefail

cd "$(dirname "$0")/.."

if [ "$#" -gt 0 ]; then
  pages=("$@")
else
  mapfile -t pages < <(git diff --name-only '@{upstream}...HEAD' -- '*.md' 2>/dev/null)
fi

checked=0
broken=0

for page in "${pages[@]}"; do
  [ -f "$page" ] || continue
  checked=$((checked + 1))
  dir=$(dirname "$page")

  while IFS= read -r target; do
    path=${target%%#*}
    [ -z "$path" ] && continue

    case "$path" in
      http://* | https://* | mailto:*) continue ;;
    esac

    if [ ! -e "$dir/$path" ]; then
      echo "$page: broken link to $target"
      broken=$((broken + 1))
    fi
  done < <(grep -o '\](\([^)]*\))' "$page" | sed 's/^](\(.*\))$/\1/')
done

echo "checked $checked files, $broken broken links"
[ "$broken" -eq 0 ]
