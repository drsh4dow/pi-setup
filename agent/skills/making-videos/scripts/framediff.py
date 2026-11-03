#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""List the spans where two renders of a video differ, so a recut can prove it changed only what it meant to.

    framediff.py OLD.mp4 NEW.mp4 [--threshold 8.0] [--allow T0-T1] [--allow T0-T1] ...
    framediff.py --self-test

Decodes both frame by frame, by index, at 384x216 grey, splits each frame into 8x8 patches, and lists each run
of frames whose worst patch differs by more than --threshold (mean absolute difference, 0-255). x264 noise
between two encodes of one picture stays under it, and the report prints the worst patch of the frames it
counts as unchanged so you can see the margin. A whole-frame mean would miss a small change: an unmasked
300x50 px email is 0.7 % of a 1080p frame. Frames past the end of the shorter file count as changed, and two
files at different frame rates fail, because frame n is then a different moment in each.
Exit 1 when a changed frame lies outside every --allow span (seconds), 0 otherwise.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from itertools import zip_longest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

W, H, P = 384, 216, 8


def grey(path: Path):
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v", "-vf", f"scale={W}:{H},format=gray",
                          "-fps_mode", "passthrough", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    while len(buf := p.stdout.read(W * H)) == W * H:
        yield np.frombuffer(buf, np.uint8).reshape(H, W).astype(np.int16)
    p.stdout.close()
    if p.wait() != 0:
        raise SystemExit(f"framediff.py: ffmpeg decode of {path} failed")


def run(old: Path, new: Path, threshold: float, allow: list[tuple[float, float]]) -> tuple[bool, list[str]]:
    fps, new_fps = _media.probe(old)["fps"], _media.probe(new)["fps"]
    if abs(fps - new_fps) > 1e-3:
        return False, [f"{old.name} runs at {fps:.3f} fps and {new.name} at {new_fps:.3f}: frames by index do not compare",
                       "Verdict: FAIL"]
    peaks = [float("inf") if a is None or b is None else
             float(np.abs(a - b).reshape(H // P, P, W // P, P).mean(axis=(1, 3)).max())
             for a, b in zip_longest(grey(old), grey(new))]
    changed = [i for i, p in enumerate(peaks) if p > threshold]
    runs = []
    for i in changed:
        if runs and runs[-1][1] == i - 1:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    stray = [i for i in changed if not any(t0 - 0.5 / fps <= i / fps <= t1 for t0, t1 in allow)]
    quiet = max((p for p in peaks if p <= threshold), default=0.0)
    peak = lambda a, b: "past the shorter file" if peaks[b] == float("inf") else f"peak {max(peaks[a:b + 1]):.1f}"  # noqa: E731
    lines = [f"{old.name} vs {new.name}: {len(peaks)} frames; {len(changed)} differ by more than {threshold} "
             f"(worst 8x8 patch at {W}x{H}); worst patch among the rest {quiet:.1f}",
             *[f"  frames {a}-{b}  {a / fps:.2f}-{(b + 1) / fps:.2f} s  {peak(a, b)}" for a, b in runs],
             f"outside --allow: {len(stray)} frames" + (f", first at {stray[0] / fps:.2f} s" if stray else ""),
             f"Verdict: {'PASS' if not stray else 'FAIL'}"]
    return not stray, lines


def self_test() -> int:
    fails = []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        _media.synth_take(d / "old.mp4", 640, 360, 3.0)
        def recode(name, *vf):
            cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(d / "old.mp4"), *vf, "-c:v", "libx264", "-crf", "23",
                   "-pix_fmt", "yuv420p", str(d / name)]
            subprocess.run(cmd, check=True)
            return d / name
        email = recode("email.mp4", "-vf", "drawbox=x=40:y=300:w=100:h=17:color=0x787878:t=fill:enable='between(t,1,2)'")
        cases = [("a re-encode of the same picture", recode("noise.mp4"), [], True),
                 ("a 100x17 px box for 1 s, not allowed", email, [], False),
                 ("a 100x17 px box for 1 s, allowed 0.9-2.1 s", email, [(0.9, 2.1)], True),
                 ("a recut 1 s shorter", recode("short.mp4", "-t", "2"), [], False),
                 ("the same picture at 25 fps", recode("fps25.mp4", "-r", "25"), [(0, 3)], False)]
        for what, new, allow, want in cases:
            ok, lines = run(d / "old.mp4", new, 8.0, allow)
            if ok != want:
                fails.append(f"{what}: {'PASS' if ok else 'FAIL'}, want {'PASS' if want else 'FAIL'}: {lines[0]}")
        cli = [sys.executable, __file__, str(d / "old.mp4"), str(email), "--allow", "0-0.5", "--allow", "0.9-2.1"]
        if subprocess.run(cli, capture_output=True).returncode != 0:
            fails.append("the box, allowed by a second --allow on the command line, failed")
        ok, lines = run(d / "old.mp4", email, 8.0, [])
        if not any("frames 30-60 " in line for line in lines):
            fails.append(f"the box (frames 30-60) was not reported as one span: {lines[1:-2]}")
    print("framediff.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    allow = [tuple(map(float, a[i + 1].split("-"))) for i, f in enumerate(a) if f == "--allow"]
    threshold = float(a[a.index("--threshold") + 1]) if "--threshold" in a else 8.0
    ok, lines = run(Path(a[0]), Path(a[1]), threshold, allow)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
