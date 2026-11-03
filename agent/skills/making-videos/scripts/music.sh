#!/usr/bin/env bash
# Generate an instrumental music bed once with ElevenLabs Music. The key travels only in the request header, read
# by curl from a pipe so it never shows in the process list.
#
#   ELEVENLABS_API_KEY=... music.sh PROMPT.txt OUT.mp3 [LENGTH_MS]
#   music.sh --self-test
#
# An existing OUT is kept and no call is made, so a rebuild never pays for or changes the bed. LENGTH_MS
# defaults to 165000. Ask for a few seconds more than the video and place the track's own ending on the end card
# with mix.sh --music-in. PROMPT.txt is the whole style brief. Check the licence terms before you publish.
set -euo pipefail
case "${1:-}" in
  ""|-h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --self-test)
    d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT; rc=0
    echo "calm pads" > "$d/prompt.txt"; echo cached > "$d/bed.mp3"
    ELEVENLABS_API_KEY="" "$0" "$d/prompt.txt" "$d/bed.mp3" > /dev/null || { echo "  a cached bed made a call"; rc=1; }
    if ELEVENLABS_API_KEY="" "$0" "$d/prompt.txt" "$d/new.mp3" 2> "$d/err"; then echo "  no key and no cache passed"; rc=1; fi
    grep -q ELEVENLABS_API_KEY "$d/err" && [ ! -e "$d/new.mp3" ] || { echo "  no clear error without a key"; rc=1; }
    mkdir "$d/bin"
    cat > "$d/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CURL_ARGV"
for a; do [ "${a#@}" = "$a" ] || cat "${a#@}" > "$CURL_ARGV.h"; done
while [ $# -gt 0 ]; do [ "$1" = -o ] && echo bed > "$2"; shift; done
printf 200
CURL
    chmod +x "$d/bin/curl"
    PATH="$d/bin:$PATH" CURL_ARGV="$d/argv" ELEVENLABS_API_KEY=sk-music-selftest "$0" "$d/prompt.txt" "$d/paid.mp3" > /dev/null 2>&1
    ! grep -q sk-music-selftest "$d/argv" && grep -qx 'xi-api-key: sk-music-selftest' "$d/argv.h" \
      || { echo "  the key was in curl's argv or not in its header"; rc=1; }
    [ "$rc" = 0 ] && echo "music.sh self-test: PASS" || echo "music.sh self-test: FAIL"
    exit "$rc" ;;
esac
PROMPT="$1" OUT="$2" LEN="${3:-165000}"
[ -s "$OUT" ] && { echo "cached $OUT"; exit 0; }
[ -n "${ELEVENLABS_API_KEY:-}" ] || { echo "music.sh: ELEVENLABS_API_KEY is unset and $OUT does not exist" >&2; exit 1; }
body="$(jq -n --rawfile p "$PROMPT" --argjson ms "$LEN" '{prompt: $p, music_length_ms: $ms, model_id: "music_v1", force_instrumental: true}')"
code="$(curl -sS --max-time 900 -o "$OUT.part" -w '%{http_code}' -X POST 'https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192' \
  -H @<(printf 'xi-api-key: %s\n' "$ELEVENLABS_API_KEY") -H 'content-type: application/json' -d "$body")"
[ "$code" = 200 ] || { echo "music.sh: HTTP $code: $(head -c 400 "$OUT.part")" >&2; rm -f "$OUT.part"; exit 1; }
mv "$OUT.part" "$OUT"
echo "$OUT $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s"
