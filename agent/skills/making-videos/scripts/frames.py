#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Contact sheets of exported frames picked by index, each tile labelled with its frame number and time.

    frames.py VIDEO.mp4 --out DIR --every 2            # one frame every 2 s: sheet-01.jpg, sheet-02.jpg, ...
    frames.py VIDEO.mp4 --out DIR --at 12.4 30.0       # those frames, full resolution: frame-<n>.png
    frames.py VIDEO.mp4 --out DIR --around 12.4 30.0   # frames n-2..n+2 around each time: around-<n>.jpg
    frames.py --self-test

Frames are selected by index (n = round(t * fps)), never by an fps resampling filter, so a tile is the frame
the viewer sees at that time. --at writes full-resolution PNGs: check redaction and small text there, not on
contact sheets. Writes DIR/frames-index.json listing every frame written. --cols and --width size the sheets.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402


def pick(video: Path, wanted: set[int]) -> dict[int, np.ndarray]:
    got = {}
    for n, f in _media.decode(video):
        if n in wanted:
            got[n] = f.copy()
        if len(got) == len(wanted):
            break
    return got


def label(img: Image.Image, n: int, fps: float) -> Image.Image:
    d = ImageDraw.Draw(img)
    txt = f"f{n}  {int(n / fps // 60)}:{n / fps % 60:06.3f}"
    fnt = _media.font(max(12, img.width // 22))
    d.rectangle([0, 0, d.textlength(txt, font=fnt) + 12, fnt.size + 10], fill=(0, 0, 0))
    d.text((6, 4), txt, font=fnt, fill=(255, 230, 0))
    return img


def sheet(frames: list[tuple[int, np.ndarray]], fps: float, cols: int, width: int) -> Image.Image:
    h0, w0 = frames[0][1].shape[:2]
    th = round(h0 * width / w0)
    rows = (len(frames) + cols - 1) // cols
    out = Image.new("RGB", (cols * width, rows * th), (40, 40, 40))
    for i, (n, f) in enumerate(frames):
        out.paste(label(Image.fromarray(f).resize((width, th), Image.LANCZOS), n, fps), ((i % cols) * width, (i // cols) * th))
    return out


def run(video: Path, out: Path, every=None, at=(), around=(), cols=5, width=384) -> list[dict]:
    info = _media.probe(video)
    fps, last = info["fps"], int(info["duration"] * info["fps"]) - 1
    idx = lambda t: min(last, max(0, round(t * fps)))  # noqa: E731
    out.mkdir(parents=True, exist_ok=True)
    written = []
    if every:
        ns = list(range(0, last + 1, max(1, round(every * fps))))
        got = pick(video, set(ns))
        per = cols * 4
        for s in range(0, len(ns), per):
            p = out / f"sheet-{s // per + 1:02d}.jpg"
            sheet([(n, got[n]) for n in ns[s:s + per] if n in got], fps, cols, width).save(p, quality=88)
            written.append({"file": p.name, "frames": ns[s:s + per]})
    if at:
        ns = [idx(t) for t in at]
        got = pick(video, set(ns))
        for n in ns:
            p = out / f"frame-{n:06d}.png"
            Image.fromarray(got[n]).save(p)
            written.append({"file": p.name, "frames": [n], "t": n / fps})
    for t in around:
        c = idx(t)
        ns = [n for n in range(c - 2, c + 3) if 0 <= n <= last]
        got = pick(video, set(ns))
        p = out / f"around-{c:06d}.jpg"
        sheet([(n, got[n]) for n in ns], fps, len(ns), width).save(p, quality=88)
        written.append({"file": p.name, "frames": ns})
    (out / "frames-index.json").write_text(json.dumps({"video": str(video), "fps": fps, "written": written}, indent=1))
    return written


def self_test() -> int:
    fails = []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        # frame n is a flat grey of value 4n, so a picked frame names its own index
        _media.write_video(d / "v.mp4", (np.full((120, 160, 3), 4 * n, np.uint8) for n in range(60)), 160, 120, 30)
        w = run(d / "v.mp4", d / "o", every=0.5, at=[1.0], around=[0.5])
        px = np.asarray(Image.open(d / "o" / "frame-000030.png"))[100, 100]
        if abs(int(px[0]) - 120) > 6:
            fails.append(f"--at 1.0 picked a frame of value {px[0]}, want frame 30 (120)")
        if [x["frames"] for x in w if x["file"].startswith("sheet")] != [[0, 15, 30, 45]]:
            fails.append(f"--every 0.5 frames {w}")
        if not any(x["file"] == "around-000015.jpg" and x["frames"] == [13, 14, 15, 16, 17] for x in w):
            fails.append(f"--around 0.5 frames {w}")
    print("frames.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()

    def vals(name):
        if name not in a:
            return []
        i, out = a.index(name) + 1, []
        while i < len(a) and not a[i].startswith("--"):
            out.append(float(a[i]))
            i += 1
        return out
    ev = vals("--every")
    w = run(Path(a[0]).resolve(), Path(a[a.index("--out") + 1]), ev[0] if ev else None, vals("--at"), vals("--around"),
            int(vals("--cols")[0]) if "--cols" in a else 5, int(vals("--width")[0]) if "--width" in a else 384)
    print("\n".join(x["file"] for x in w))
    return 0


if __name__ == "__main__":
    sys.exit(main())
