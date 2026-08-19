# Atomic command capture

Define these Bash functions before a route writes command output. They remove failed temporary output and promote only nonempty completed artifacts:

```bash
capture() {
  local output="$1" tmp
  shift
  tmp="${output}.tmp"
  test ! -e "$output" || return 2
  rm -f -- "$tmp"
  if "$@" > "$tmp" && test -s "$tmp"; then
    mv -- "$tmp" "$output"
  else
    rm -f -- "$tmp"
    return 1
  fi
}

capture_json() {
  local output="$1" tmp
  shift
  tmp="${output}.tmp"
  test ! -e "$output" || return 2
  rm -f -- "$tmp"
  if "$@" > "$tmp" \
    && test -s "$tmp" \
    && python -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp"; then
    mv -- "$tmp" "$output"
  else
    rm -f -- "$tmp"
    return 1
  fi
}
```

Use `capture_json` for JSON and `capture` for text or Markdown. Assign a new final path for every attempt; these functions prevent partial files, not intentional replacement.
