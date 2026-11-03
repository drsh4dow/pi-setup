#!/usr/bin/env bash
# Mix the voice with an optional music bed and mux the mix into the video.
#
#   mix.sh VIDEO.mp4 VOICE.wav OUT.mp4 [--music BED.mp3] [--music-in 0] [--bed-db -6]
#   mix.sh --self-test
#
# The voice is normalised to -16 LUFS. The bed is brought to the same loudness by a plain gain, set --bed-db under
# it, and ducked while the voice speaks (sidechain: threshold 0.015, ratio 2, attack 40 ms, release 900 ms), which
# leaves it about 16 dB under the voice. The duck looks ahead 120 ms, so a line's first consonant never lands on
# full music. The bed starts --music-in s into its track: pick it so the track's own ending, which music
# generators write as a resolve and decay, lands on the end card instead of under a fade. A 1 s fade in and a
# 0.8 s fade out frame it. The mix gets two-pass linear loudnorm to -16 LUFS integrated, true peak at most
# -2 dBTP, and is muxed with the video stream and any subtitle track (both copied) as AAC 192k with faststart,
# cut to the video's length. With no --music the voice alone is normalised and muxed. Needs ffmpeg and jq.
set -euo pipefail

self_test() {
  local d rc=0
  d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN
  level() { ffmpeg -hide_banner -nostats -ss "$2" -t "$3" -i "$1" -af "$4,volumedetect" -f null - 2>&1 | sed -n 's/.*mean_volume: \(-\{0,1\}[0-9.]*\) dB/\1/p'; }
  is() { awk "BEGIN { exit !($1) }" || { echo "  $2 ($1)"; rc=1; }; }
  printf '1\n00:00:01,000 --> 00:00:03,000\nA caption.\n\n' > "$d/v.srt"
  ffmpeg -v error -f lavfi -i testsrc2=s=320x200:r=30:d=30 -i "$d/v.srt" -c:v libx264 -pix_fmt yuv420p -c:s mov_text "$d/v.mp4"
  ffmpeg -v error -f lavfi -i "sine=f=1000:d=28,volume='gte(t,1)*lt(t,25)*lt(mod(t-1,3),2)':eval=frame" -ar 48000 "$d/voice.wav"
  ffmpeg -v error -f lavfi -i "sine=f=100:d=40,volume='0.1*gte(t,2)':eval=frame" -ar 44100 "$d/bed.wav"
  for name in plain music; do
    local f="$d/$name.mp4" args=()
    [ "$name" = plain ] || args=(--music "$d/bed.wav" --music-in 2)
    "$0" "$d/v.mp4" "$d/voice.wav" "$f" "${args[@]}" > /dev/null || { echo "  $name: mix.sh exited $?"; rc=1; continue; }
    local loud i tp onset
    loud="$(ffmpeg -hide_banner -nostats -i "$f" -af ebur128=peak=true -f null - 2>&1)"
    i="$(sed -n 's/^ *I: *\(-\{0,1\}[0-9.]*\) LUFS/\1/p' <<<"$loud" | tail -1)"
    tp="$(sed -n 's/^ *Peak: *\(-\{0,1\}[0-9.]*\) dBFS/\1/p' <<<"$loud" | tail -1)"
    is "$i >= -16.5 && $i <= -15.5" "$name: integrated loudness $i LUFS, want -16 +/- 0.5"
    is "$tp <= -1.5" "$name: true peak $tp dBTP, want at most -1.5"
    [ "$(ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$f")" = aac ] || { echo "  $name: audio is not AAC"; rc=1; }
    [ "$(ffprobe -v error -select_streams s -show_entries stream=codec_name -of csv=p=0 "$f")" = mov_text ] || { echo "  $name: the subtitle track was lost"; rc=1; }
    is "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f") - 30 < 0.05" "$name: longer than the 30 s video"
    [ "$(grep -aobm2 -E 'moov|mdat' "$f" | head -1 | cut -d: -f2)" = moov ] || { echo "  $name: no faststart (mdat before moov)"; rc=1; }
    onset="$(ffmpeg -hide_banner -nostats -i "$f" -af "highpass=f=500,silencedetect=noise=-30dB:d=0.3" -f null - 2>&1 | sed -n 's/.*silence_end: \([0-9.]*\).*/\1/p' | head -1)"
    is "${onset:-0} > 0.97 && ${onset:-0} < 1.03" "$name: voice starts at ${onset:-never} s, want 1.0 (look-ahead not compensated)"
  done
  local voice bed_under bed_free bed_start
  voice="$(level "$d/music.mp4" 1.5 1.4 highpass=f=500)"
  bed_under="$(level "$d/music.mp4" 1.5 1.4 lowpass=f=300)"
  bed_free="$(level "$d/music.mp4" 26.2 2.5 lowpass=f=300)"
  bed_start="$(level "$d/music.mp4" 0.5 0.45 lowpass=f=300)"
  is "$voice - $bed_under >= 12 && $voice - $bed_under <= 20" "bed $voice - $bed_under dB under the voice, want about 16"
  is "$bed_free - $bed_under >= 4" "bed does not duck: $bed_free dB alone, $bed_under dB under the voice"
  is "$bed_start > -45" "bed silent at 0.5 s ($bed_start dB): --music-in 2 not applied"
  [ "$rc" = 0 ] && echo "mix.sh self-test: PASS" || echo "mix.sh self-test: FAIL"
  return "$rc"
}

case "${1:-}" in
  ""|-h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --self-test) self_test; exit $? ;;
esac

VIDEO="$1" VOICE="$2" OUT="$3"; shift 3
MUSIC="" IN=0 BED=-6
while [ $# -gt 0 ]; do
  case "$1" in
    --music) MUSIC="$2"; shift 2 ;;
    --music-in) IN="$2"; shift 2 ;;
    --bed-db) BED="$2"; shift 2 ;;
    *) echo "mix.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
w="$(mktemp -d)"
trap 'rm -rf "$w"' EXIT
dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$VIDEO")"
# A ceiling of -2 dBTP, not -1.5: AAC encoding pushed a real voice 0.1 dB past the limiter.
LN="loudnorm=I=-16:TP=-2:LRA=11"
measure() { ffmpeg -hide_banner -nostats -i "$1" -af "$LN:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p'; }
norm() {
  local m; m="$(measure "$1")"
  ffmpeg -v error -y -i "$1" -af "$LN:linear=true:measured_I=$(jq -r .input_i <<<"$m"):measured_TP=$(jq -r .input_tp <<<"$m"):measured_LRA=$(jq -r .input_lra <<<"$m"):measured_thresh=$(jq -r .input_thresh <<<"$m"):offset=$(jq -r .target_offset <<<"$m"),aresample=48000" "$2"
}
if [ -z "$MUSIC" ]; then
  ffmpeg -v error -y -i "$VOICE" -af apad -t "$dur" "$w/raw.wav"
else
  norm "$VOICE" "$w/voice.wav"
  gain="$(jq -r --argjson bed "$BED" '-16 - (.input_i | tonumber) + $bed' <<<"$(measure "$MUSIC")")"
  fade="$(awk -v d="$dur" 'BEGIN { print d - 0.8 }')"
  ffmpeg -v error -y -i "$w/voice.wav" -i "$MUSIC" -filter_complex "
    [0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,asplit=2[v0][key];
    [v0]adelay=120:all=1[v];
    [1:a]atrim=start=$IN,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${gain}dB,afade=t=in:d=1,afade=t=out:st=$fade:d=0.8,adelay=120:all=1,apad[m];
    [m][key]sidechaincompress=threshold=0.015:ratio=2:attack=40:release=900:knee=4[duck];
    [v][duck]amix=inputs=2:normalize=0,atrim=start=0.12,asetpts=PTS-STARTPTS[mix]" -map "[mix]" -t "$dur" "$w/raw.wav"
fi
norm "$w/raw.wav" "$w/mix.wav"
ffmpeg -v error -y -i "$VIDEO" -i "$w/mix.wav" -map 0:v -map "0:s?" -map 1:a -c:v copy -c:s copy -c:a aac -b:a 192k \
  -movflags +faststart -t "$dur" "$OUT"
echo "$OUT $(sha256sum "$OUT" | cut -c1-16) $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s"
