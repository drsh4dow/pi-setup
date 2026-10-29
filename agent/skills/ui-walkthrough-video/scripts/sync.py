#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "faster-whisper"]
# ///
"""Measure caption timing on the exported mp4: each caption's first frame in the pixels against the moment
the voice says its first word, heard by a local speech recognizer.

    HF_HUB_OFFLINE=1 sync.py TIMELINE.json [--video V.mp4] [--out DIR] [--limit 0.3]
    sync.py TIMELINE.json --words WORDS.json     # word times from a file instead of ASR (not a measurement)
    sync.py --self-test

Captions: every frame's caption box (timeline caption_box) is decoded from the export and reduced to 8x8
block means. A caption appears where the box's pixels change; the timeline only says which caption should
appear near which time (within WINDOW s), never what time to report. A change back to the empty box (a frame
the timeline marks caption-free) is a hide, not a show.
Words: faster-whisper (WHISPER_MODEL, default small.en; CPU, int8) transcribes the export's audio with word
timestamps. The audio never leaves the machine. Each caption's first word is found by aligning caption
tokens with heard tokens; its onset is the last rise of the audio envelope above -40 dBFS after >= 80 ms
below it, within 1.2 s before that word's end (Whisper stretches word starts back over pauses).
Offset = caption's first frame - speech onset; |offset| over --limit fails, and so does a caption that never
appears. A caption whose first word was not heard as written is listed as not measured.
This is speech recognition, not a person listening: report the human listening pass as not measured.
Writes DIR/sync.md and DIR/sync.json. Exit 0 on pass.
"""
from __future__ import annotations

import difflib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

BLK, EVENT, BLANK_MAX, WINDOW, SR = 8, 3.0, 4.0, 1.0, 16000


def toks(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", s.lower().replace("-", " ").replace("'", ""))


def band_cells(video: Path, box) -> np.ndarray:
    x, y, w, h = box
    w, h = w // BLK * BLK, h // BLK * BLK
    return np.stack([f.reshape(h // BLK, BLK, w // BLK, BLK, 3).mean(axis=(1, 3)).astype(np.float32)
                     for _, f in _media.decode(video, crop=(x, y, w, h))])


def show_events(cells: np.ndarray, blank: np.ndarray | None) -> list[int]:
    change = np.r_[0.0, np.abs(np.diff(cells, axis=0)).mean(axis=(1, 2, 3))]
    out, prev = [], False
    for f, c in enumerate(change):
        hit = c > EVENT
        if hit and not prev:
            settle = cells[min(f + 2, len(cells) - 1)]
            if blank is None or np.abs(settle - blank).mean() > BLANK_MAX:
                out.append(f)
        prev = hit
    return out


def audio(video: Path) -> np.ndarray | None:
    if not _media.probe(video)["audio"]:
        return None
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(pcm, np.float32).copy()


def onsets(a: np.ndarray, hop=0.01, thr_db=-40.0, quiet=0.08) -> np.ndarray:
    n = int(hop * SR)
    fr = a[: len(a) // n * n].reshape(-1, n)
    loud = 10 * np.log10(np.mean(fr ** 2, axis=1) + 1e-12) >= thr_db
    out, run = [], 0
    for i, v in enumerate(loud):
        if not v:
            run += 1
        else:
            if run * hop >= quiet:
                out.append(i * hop)
            run = 0
    return np.array(out)


def heard_words(a: np.ndarray) -> list[dict]:
    import os

    from faster_whisper import WhisperModel  # noqa: PLC0415
    model = WhisperModel(os.environ.get("WHISPER_MODEL", "small.en"), device="cpu", compute_type="int8")
    segs, _ = model.transcribe(a, language="en", beam_size=5, word_timestamps=True, condition_on_previous_text=False)
    return [{"w": w.word.strip(), "start": w.start, "end": w.end} for s in segs for w in s.words]


def run(timeline: Path, video: Path | None, out: Path, limit: float, words_file: Path | None):
    tl = _media.Timeline(timeline)
    video = video or tl.video
    caps, box = tl.d.get("captions", []), tl.d.get("caption_box")
    if not caps or not box:
        raise SystemExit("sync.py: the timeline has no captions or no caption_box")
    cells = band_cells(video, box)
    fps, nfr = tl.fps, len(cells)
    free = [f for f in range(nfr) if not any(c["show"] <= f / fps < c["hide"] for c in caps)]
    blank = cells[free[len(free) // 2]] if free else None
    events = show_events(cells, blank)
    first, used = {}, -1
    for i, c in enumerate(caps):
        cand = [f for f in events if f > used and abs(f / fps - c["show"]) <= WINDOW]
        if cand:
            first[i] = used = cand[0]
    a = audio(video)
    if words_file:
        heard, source = json.loads(Path(words_file).read_text()), f"word times from {words_file} (not heard from the export)"
    elif a is None:
        raise SystemExit("sync.py: the export has no audio to listen to")
    else:
        heard, source = heard_words(a), "local faster-whisper on the export's audio"
    ons = onsets(a) if a is not None else np.array([])
    exp, cap_first = [], []
    for c in caps:
        cap_first.append(len(exp))
        exp += toks(c["text"])
    htoks, hidx = [], []
    for j, w in enumerate(heard):
        for t in toks(w["w"]):
            htoks.append(t)
            hidx.append(j)
    sm = difflib.SequenceMatcher(a=exp, b=htoks, autojunk=False)
    e2h = {a0 + k: b0 + k for a0, b0, n in sm.get_matching_blocks() for k in range(n)}
    agree = sum(n for *_, n in sm.get_matching_blocks())
    rows = []
    for i, c in enumerate(caps):
        r = {"i": i, "text": c["text"], "planned_show": round(c["show"], 3), "frame": first.get(i), "note": ""}
        r["shown"] = None if r["frame"] is None else r["frame"] / fps
        if r["frame"] is None:
            r["note"] = "caption never found in the exported frames"
        k = cap_first[i]
        if k in e2h:
            w = heard[hidx[e2h[k]]]
            near = ons[(ons >= w["end"] - 1.2) & (ons <= w["end"] - 0.05)] if len(ons) else []
            r["word"], r["onset"] = [w["start"], w["end"]], float(near.max()) if len(near) else float(w["start"])
        else:
            r["word"] = r["onset"] = None
            r["note"] = r["note"] or f"first word '{c['text'].split()[0]}' not heard as written: not measured"
        r["offset"] = r["shown"] - r["onset"] if r["shown"] is not None and r["onset"] is not None else None
        rows.append(r)
    scored = [r for r in rows if r["offset"] is not None]
    over = [r for r in scored if abs(r["offset"]) > limit]
    missing = [r for r in rows if r["frame"] is None]
    ok = not over and not missing
    out.mkdir(parents=True, exist_ok=True)
    (out / "sync.json").write_text(json.dumps({"video": str(video), "words_source": source, "rows": rows,
                                               "events": events, "heard": heard}, indent=1))
    worst = max(scored, key=lambda r: abs(r["offset"])) if scored else None
    f = lambda v: "—" if v is None else f"{v:.3f}"  # noqa: E731
    g = lambda v: "—" if v is None else f"{v:+.3f}"  # noqa: E731
    md = ["# Caption sync on the export", "", f"Video: {video}. Words: {source}. Captions: pixels of {box}.", "",
          f"Captions found in the pixels: {len(rows) - len(missing)} of {len(rows)}. Scored: {len(scored)}; "
          f"not measured: {len(rows) - len(scored)}; over {limit} s: {len(over)}.",
          f"Caption words heard in order: {agree} of {len(exp)} ({100 * agree / max(1, len(exp)):.1f} %), spelling "
          "agreement, not intelligibility.",
          (f"Worst offset: {worst['offset']:+.3f} s at {f(worst['shown'])} s, '{worst['text'][:60]}'." if worst else
           "Worst offset: not measured."), "",
          "| # | First frame | Shown (s) | Speech onset (s) | Offset (s) | Caption | Note |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          *[f"| {r['i']} | {r['frame'] if r['frame'] is not None else '—'} | {f(r['shown'])} | {f(r['onset'])} | "
            f"{g(r['offset'])} | "
            f"{r['text'][:70]} | {r['note']} |" for r in rows],
          "", "Human listening pass: not measured.", f"Verdict: {'PASS' if ok else 'FAIL'}"]
    (out / "sync.md").write_text("\n".join(md) + "\n")
    return ok, [line for line in md if not line.startswith("| ")]


def self_test() -> int:
    fails = []
    caps = [("Alpha one.", 0.5, 1.9), ("Bravo two.", 2.0, 3.4), ("Charlie three.", 4.0, 5.5)]
    fnt = _media.font(28)
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        words = [{"w": w, "start": s + 0.05 + 0.3 * j, "end": s + 0.3 + 0.3 * j}
                 for t, s, _ in caps for j, w in enumerate(t.split())]
        (d / "words.json").write_text(json.dumps(words))

        def export(name, shown):
            fps, secs = 30, 6.0

            def frames():
                for k in range(int(secs * fps)):
                    img = Image.new("RGB", (640, 360), (226, 232, 240))
                    dr = ImageDraw.Draw(img)
                    dr.rectangle([20, 10, 620, 290], fill=(250, 250, 252))
                    for text, s, e in shown:
                        if s <= k / fps < e:
                            dr.rounded_rectangle([180, 305, 460, 350], 12, fill=(15, 23, 42))
                            dr.text((200, 310), text, font=fnt, fill=(255, 255, 255))
                    yield np.asarray(img)
            _media.write_video(d / f"{name}.mp4", frames(), 640, 360, fps)
            tl = {"video": str(d / f"{name}.mp4"), "fps": fps, "canvas": [640, 360], "total": secs,
                  "caption_box": [0, 300, 640, 60], "shots": [],
                  "captions": [{"text": t, "show": s, "hide": e} for t, s, e in caps]}
            (d / f"{name}.json").write_text(json.dumps(tl))
            return run(d / f"{name}.json", None, d / name, 0.3, d / "words.json")[0]

        if not export("ontime", caps):
            fails.append("captions shown on their words failed")
        if export("late", [caps[0], ("Bravo two.", 2.6, 3.4), caps[2]]):
            fails.append("a caption 0.6 s late passed")
        if export("missing", [caps[0], caps[2]]):
            fails.append("a caption that never appears passed")
    print("sync.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
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
    words = Path(arg(a, "--words")) if "--words" in a else None
    ok, md = run(tl, video, Path(arg(a, "--out", tl.parent / "checks")), float(arg(a, "--limit", 0.3)), words)
    print("\n".join(md))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
