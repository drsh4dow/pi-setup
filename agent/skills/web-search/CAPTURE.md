# Atomic command capture

Define these Bash functions before a route writes command output. A successful command moves a nonempty temporary file into place. A failed command leaves no partial result.

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

Use `capture_json` for JSON and `capture` for text or Markdown. Give every attempt a new final path and one writer. These functions reject replacement and remove partial files. Exit status 2 means the final path already exists. Exit status 1 means the command failed, produced empty output, or produced invalid JSON.
