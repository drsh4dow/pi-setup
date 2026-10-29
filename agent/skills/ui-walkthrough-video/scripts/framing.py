#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Prove the export shows each take's whole viewport at one scale and place: no zoom, pan or crop.

    framing.py TIMELINE.json [--video V.mp4] [--out DIR] [--per-second 2]
    framing.py --self-test

Reads the timeline contract (see _media.py). Two witnesses:
1. One scale: every shot's view is its take's size times the same factor (within 0.5 %), and takes of one
   size sit in one place.
2. Pixels: frames of the export, selected by index (per-second samples, no time resampling), are compared in
   the shot's view with the take frame the timeline names, resized whole (best of that frame and its two
   neighbours). The same comparison against that take frame zoomed 1.1x on its centre, and shifted 8 px, shows
   what a zoom or a pan would score. Every sampled frame must match the fixed picture better than both.

Writes DIR/framing.md and DIR/framing.json (DIR defaults to checks/ beside the timeline). Exit 0 on pass.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

MODES = ("fixed", "zoom1.1", "shift8")


def expected(src: Image.Image, mode: str, vw: int, vh: int) -> np.ndarray:
    img = src
    if mode == "zoom1.1":
        w, h = src.size
        cw, ch = w / 1.1, h / 1.1
        img = src.crop(((w - cw) / 2, (h - ch) / 2, (w + cw) / 2, (h + ch) / 2))
    view = np.asarray(img.resize((vw, vh), Image.LANCZOS).convert("RGB")).astype(np.int16)
    return np.roll(view, 8, axis=1) if mode == "shift8" else view


def scale_errors(tl: _media.Timeline) -> list[str]:
    errs, places = [], {}
    ks = [(s["view"][2] / s["size"][0], s["view"][3] / s["size"][1]) for s in tl.shots]
    k0 = ks[0][0]
    for s, (kx, ky) in zip(tl.shots, ks):
        if abs(kx - k0) / k0 > 0.005 or abs(ky - k0) / k0 > 0.005:
            errs.append(f"{Path(s['take']).name}: view {s['view']} is scale {kx:.4f} x {ky:.4f}, first shot {k0:.4f}")
        places.setdefault(tuple(s["size"]), set()).add(tuple(s["view"]))
    errs += [f"takes of size {k} sit in {len(v)} places: {sorted(v)}" for k, v in places.items() if len(v) > 1]
    return errs


def run(timeline: Path, video: Path | None, out: Path, per_second: int) -> tuple[bool, list[str]]:
    tl = _media.Timeline(timeline)
    video = video or tl.video
    step = max(1, round(tl.fps / per_second))
    rows, fps_of = [], {}
    for n, img in _media.decode(video, every=step):
        t = n / tl.fps
        shot = tl.shot_at(t)
        vx, vy, vw, vh = shot["view"]
        tw, th = shot["size"]
        if shot["take"] not in fps_of:
            fps_of[shot["take"]] = _media.probe(shot["take"])["fps"] or 30
        got = img[vy:vy + vh, vx:vx + vw].astype(np.int16)
        scores = {}
        for src in _media.frames_near(shot["take"], tl.src_at(shot, t), fps_of[shot["take"]], tw, th):
            for mode in MODES:
                mad = float(np.abs(got - expected(src, mode, vw, vh)).mean())
                scores[mode] = min(scores.get(mode, 1e9), mad)
        rows.append({"frame": n, "t": round(t, 3), "take": Path(shot["take"]).name, **scores})
    errs = scale_errors(tl)
    beaten = [r for r in rows if r["fixed"] < min(r["zoom1.1"], r["shift8"])]
    worst = max(rows, key=lambda r: r["fixed"]) if rows else None
    ok = bool(rows) and not errs and len(beaten) == len(rows)
    out.mkdir(parents=True, exist_ok=True)
    (out / "framing.json").write_text(json.dumps({"video": str(video), "rows": rows, "scale_errors": errs}, indent=1))
    col = lambda m: np.array([r[m] for r in rows]) if rows else np.zeros(1)  # noqa: E731
    md = ["# Framing: whole viewport, one scale, one place", "",
          f"Source: {video}, every {step}th frame by index ({len(rows)} frames). Per-frame numbers: framing.json.", "",
          f"One scale across {len(tl.shots)} shots: " + ("yes" if not errs else "NO"), *[f"- {e}" for e in errs], "",
          "| Expected picture | Median MAD | Max MAD |", "| --- | --- | --- |",
          *[f"| {m} | {np.median(col(m)):.2f} | {col(m).max():.2f} |" for m in MODES], "",
          f"Frames where the fixed picture beats both the zoom and the shift: {len(beaten)} of {len(rows)}."]
    if worst:
        md.append(f"Worst fixed-scale frame: {worst['frame']} ({worst['t']} s, {worst['take']}), MAD {worst['fixed']:.2f}.")
    md += ["", f"Verdict: {'PASS' if ok else 'FAIL'}"]
    (out / "framing.md").write_text("\n".join(md) + "\n")
    return ok, md


def self_test() -> int:
    fails = []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        tw, th, fps, secs = 320, 200, 30, 2.0
        _media.synth_take(d / "take.mp4", tw, th, secs, fps)
        view = [40, 20, 480, 300]
        takes = [np.asarray(f[1]) for f in _media.decode(d / "take.mp4")]

        def export(name, mode):
            def frames():
                for k in range(int(secs * fps)):
                    canvas = Image.new("RGB", (560, 360), (226, 232, 240))
                    src = Image.fromarray(takes[min(k, len(takes) - 1)])
                    m = mode if k >= fps else "fixed"   # the second second goes wrong
                    v = expected(src, {"zoom": "zoom1.1", "shift": "shift8"}.get(m, "fixed"), 480, 300)
                    if m == "shift":
                        v = np.roll(v, 4, axis=1)      # 12 px in all
                    canvas.paste(Image.fromarray(v.astype(np.uint8)), (view[0], view[1]))
                    yield np.asarray(canvas)
            _media.write_video(d / f"{name}.mp4", frames(), 560, 360, fps)
            tl = {"video": str(d / f"{name}.mp4"), "fps": fps, "canvas": [560, 360], "total": secs,
                  "shots": [{"take": str(d / "take.mp4"), "size": [tw, th], "view": view, "out0": 0, "out1": secs,
                             "pieces": [[0, secs, "play", 0, secs, 1.0]]}]}
            (d / f"{name}.json").write_text(json.dumps(tl))
            return run(d / f"{name}.json", None, d / name, 4)[0]

        if not export("clean", "fixed"):
            fails.append("a whole-viewport export failed")
        if export("zoomed", "zoom"):
            fails.append("an export zoomed 1.1x for one second passed")
        if export("shifted", "shift"):
            fails.append("an export panned 12 px for one second passed")
        tl = _media.Timeline(d / "clean.json")
        tl.shots.append(dict(tl.shots[0], view=[40, 20, 400, 250]))
        if not scale_errors(tl):
            fails.append("two shots at different scales passed the scale witness")
    print("framing.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def arg(a, name, default=None):
    return a[a.index(name) + 1] if name in a else default


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    tl = Path(a[0]).resolve()
    video = Path(arg(a, "--video")).resolve() if "--video" in a else None
    ok, md = run(tl, video, Path(arg(a, "--out", tl.parent / "checks")), int(arg(a, "--per-second", 2)))
    print("\n".join(md))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
