#!/usr/bin/env bash
# Audio and picture checks on an exported walkthrough.
#
#   check.sh VIDEO.mp4 [--timeline T.json] [--out DIR] [--dead-air 1.0] [--between 0.5] [--inline 0.6] [--sheet-every 2]
#   check.sh --self-test
#
# Writes to DIR (default checks/ beside VIDEO): ffprobe.json; freeze-silence.txt, every span over --dead-air
# seconds where the picture is frozen (freezedetect -50 dB) and the sound silent (silencedetect -35 dB) at once,
# which is dead air; quiet-gaps.txt, when a timeline names the narration lines, quiet spans (-35 dB, >= 0.1 s)
# between lines (bar --between) and inside one line (bar --inline); loudness (EBU R128 integrated, LRA, true
# peak); and contact sheets of frames picked by index every --sheet-every seconds (frames.py).
# Exit 1 on dead air or a quiet span over its bar, 0 otherwise.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

self_test() {
  local d rc=0
  d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN
  ffmpeg -v error -f lavfi -i testsrc2=s=320x200:r=30:d=4 -f lavfi -i sine=f=330:d=4 -shortest -c:v libx264 -pix_fmt yuv420p "$d/good.mp4"
  ffmpeg -v error -f lavfi -i color=c=gray:s=320x200:r=30:d=3 -f lavfi -i anullsrc=r=48000:cl=mono -t 3 -c:v libx264 -pix_fmt yuv420p "$d/dead.mp4"
  ffmpeg -v error -f lavfi -i testsrc2=s=320x200:r=30:d=4 -f lavfi \
    -i "sine=f=330:d=4,volume='if(between(t,1.5,2.5),0,1)':eval=frame" -shortest -c:v libx264 -pix_fmt yuv420p "$d/gap.mp4"
  printf '{"lines":[{"text":"a","start":0.1,"end":1.5},{"text":"b","start":2.5,"end":3.9}]}' > "$d/gap.json"
  "$0" "$d/good.mp4" --out "$d/c1" > /dev/null || { echo "  moving picture with steady sound failed"; rc=1; }
  if "$0" "$d/dead.mp4" --out "$d/c2" > /dev/null; then echo "  3 s of frozen, silent video passed"; rc=1; fi
  if "$0" "$d/gap.mp4" --timeline "$d/gap.json" --out "$d/c3" > /dev/null; then echo "  a 1.0 s gap between lines passed"; rc=1; fi
  ls "$d"/c1/sheet-*.jpg > /dev/null 2>&1 || { echo "  no contact sheet written"; rc=1; }
  [ "$rc" = 0 ] && echo "check.sh self-test: PASS" || echo "check.sh self-test: FAIL"
  return "$rc"
}

case "${1:-}" in
  ""|-h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  --self-test) self_test; exit $? ;;
esac

V="$(realpath "$1")"; shift
T="" OUT="" DEAD=1.0 BETWEEN=0.5 INLINE=0.6 EVERY=2
while [ $# -gt 0 ]; do
  case "$1" in
    --timeline) T="$(realpath "$2")"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --dead-air) DEAD="$2"; shift 2 ;;
    --between) BETWEEN="$2"; shift 2 ;;
    --inline) INLINE="$2"; shift 2 ;;
    --sheet-every) EVERY="$2"; shift 2 ;;
    *) echo "check.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
C="${OUT:-$(dirname "$V")/checks}"
mkdir -p "$C"
ffprobe -v error -show_entries format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate,sample_rate,channels -of json "$V" > "$C/ffprobe.json"
ffmpeg -hide_banner -nostats -i "$V" -vf "freezedetect=n=-50dB:d=$DEAD" -map 0:v -f null - 2> "$C/freezedetect.log"
ffmpeg -hide_banner -nostats -i "$V" -af "silencedetect=noise=-35dB:d=$DEAD" -map 0:a -f null - 2> "$C/silencedetect.log"
ffmpeg -hide_banner -nostats -i "$V" -af "silencedetect=noise=-35dB:d=0.1" -map 0:a -f null - 2> "$C/silencedetect-0.1s.log"
ffmpeg -hide_banner -nostats -i "$V" -af "ebur128=peak=true" -map 0:a -f null - 2> "$C/ebur128.log" || true

set +e
python3 - "$C" "$DEAD" "$BETWEEN" "$INLINE" "${T:-}" <<'EOF'
import json, re, sys
c, dead, between, inline, tpath = sys.argv[1], *map(float, sys.argv[2:5]), sys.argv[5]
dur = float(json.load(open(f"{c}/ffprobe.json"))["format"]["duration"])
def spans(path, a, b):
    txt = open(path).read()
    s = [float(x) for x in re.findall(a + r":\s*([\d.]+)", txt)]
    e = [float(x) for x in re.findall(b + r":\s*([\d.]+)", txt)]
    return list(zip(s, e + [dur] * (len(s) - len(e))))
fr = spans(f"{c}/freezedetect.log", "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end")
si = spans(f"{c}/silencedetect.log", "silence_start", "silence_end")
over = [(round(max(a0, b0), 2), round(min(a1, b1), 2)) for a0, a1 in fr for b0, b1 in si if min(a1, b1) - max(a0, b0) > dead]
log = open(f"{c}/ebur128.log").read()
lufs, lra, tp = (re.findall(p, log) for p in (r"I:\s*(-?[\d.]+) LUFS", r"LRA:\s*(-?[\d.]+) LU", r"Peak:\s*(-?[\d.]+) dBFS"))
out = [f"duration {dur:.2f} s",
       f"frozen spans >= {dead} s: {len(fr)}", *[f"  {a:.2f}-{b:.2f}" for a, b in fr],
       f"silent spans >= {dead} s: {len(si)}", *[f"  {a:.2f}-{b:.2f}" for a, b in si],
       f"dead air (frozen and silent at once, over {dead} s): {len(over)}", *[f"  {a:.2f}-{b:.2f} ({b - a:.2f} s)" for a, b in over],
       f"loudness: {lufs[-1] if lufs else 'not measured'} LUFS integrated, LRA {lra[-1] if lra else 'not measured'} LU, "
       f"true peak {tp[-1] if tp else 'not measured'} dBFS"]
open(f"{c}/freeze-silence.txt", "w").write("\n".join(out) + "\n")
print("\n".join(out))
bad = bool(over)
if tpath:
    lines = json.load(open(tpath)).get("lines", [])
    q = spans(f"{c}/silencedetect-0.1s.log", "silence_start", "silence_end")
    btw, inl, edge = [], [], []
    for a, b in q:
        if not lines or b <= lines[0]["start"] + 0.05 or b >= dur - 0.05 or a >= lines[-1]["end"] - 0.05:
            edge.append((a, b))
            continue
        host = next((ln for ln in lines if ln["start"] + 0.05 <= a and b <= ln["end"] - 0.05), None)
        (inl if host else btw).append((a, b))
    wb = max((b - a for a, b in btw), default=0.0)
    wi = max((b - a for a, b in inl), default=0.0)
    g = [f"quiet spans (-35 dB, >= 0.1 s) against {len(lines)} narration lines",
         f"between lines: {len(btw)}; max {wb:.3f} s; over {between} s: {sum(1 for a, b in btw if b - a > between)}",
         *[f"  {a:.3f}-{b:.3f} ({b - a:.3f} s)" for a, b in btw if b - a > between],
         f"inside a line: {len(inl)}; max {wi:.3f} s; over {inline} s: {sum(1 for a, b in inl if b - a > inline)}",
         *[f"  {a:.3f}-{b:.3f} ({b - a:.3f} s)" for a, b in inl if b - a > inline],
         f"lead-in and tail: {len(edge)}", *[f"  {a:.3f}-{b:.3f}" for a, b in edge]]
    open(f"{c}/quiet-gaps.txt", "w").write("\n".join(g) + "\n")
    print("\n".join(g))
    bad = bad or wb > between or wi > inline
sys.exit(1 if bad else 0)
EOF
rc=$?
set -e
rm -f "$C"/sheet-*.jpg
"$HERE/frames.py" "$V" --out "$C" --every "$EVERY" > /dev/null
echo "contact sheets: $(ls "$C"/sheet-*.jpg | wc -l) in $C"
exit "$rc"
