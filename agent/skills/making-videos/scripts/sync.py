#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow", "faster-whisper"]
# ///
"""Caption checks on the exported mp4: how long each caption stays on screen (holds), and when it appears
against the moment the voice says its first word, heard by a local speech recognizer (sync).

    HF_HUB_OFFLINE=1 sync.py TIMELINE.json [--profile narrated|captions] [--video V.mp4] [--voice VOICE.wav] [--out DIR]
    sync.py VIDEO.mp4 [same options]                                  # soft subtitles: the export's own cues
    sync.py voice.json --video V.mp4 --caption-box X,Y,W,H [same options]   # a composed film, captions burned in
    sync.py --self-test

Captions: every frame's caption box (timeline caption_box) is decoded from the export and reduced to 8x8
block means. A caption's span runs from one burst of change in the box to the next, where a burst is any block
moving more than EVENT, so thin text fading in over a few frames still counts. A burst that leaves the box within
BLANK_MAX of what it showed before (an x264 keyframe redrawing the same caption) does not end a span. The span
shows a caption when its middle frame differs from the empty box by more than BLANK_MAX in any block; the empty box
is the median of the frames the timeline marks caption-free, so a late caption does not count as empty. With no
caption_box and soft subtitles (timeline "subtitles", or a VIDEO with a subtitle track), each cue's start, end and
text are read from the export's own subtitle track, and a cue shows a caption only when its text is the caption's.
The timeline only says which caption should appear near which time (within WINDOW s), never what time to report.
voice.json's caption start and end stand for show and hide.
Holds (captions profile): each caption must stay on screen at least HOLD_BASE s plus PER_WORD s per word, and
end a sentence (. ! ? or ...), so no sentence is split across captions. A caption that never shows fails. The
narrated profile reports how long each caption holds and fails none: a narrated caption lasts as long as its
spoken clause, and narrate.py splits captions at clauses on purpose.
Sync (narrated profile only; captions reports it not applicable): the export must have audio. faster-whisper
(WHISPER_MODEL, default small.en; CPU, int8) transcribes it with word timestamps; the audio never leaves the
machine. --voice (default the timeline's voice track) takes words and onsets from the voice instead, which a
music bed cannot mask, once its loudness over time matches the export's audio at zero lag (correlation at least
VOICE_MATCH); a voice the export does not carry, on the export's clock, exits 1.
Each caption's first word is found by aligning caption tokens with heard tokens; its onset is the last rise of
the audio envelope above -40 dBFS after >= 80 ms below it, within 1.2 s before that word's end (Whisper
stretches word starts back over pauses). Offset = caption's first frame - speech onset; |offset| over LIMIT
fails. A caption whose first word was not heard as written is not measured, and sync fails when fewer than
MEASURED of the captions were measured.
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

BLK, EVENT, BLANK_MAX, WINDOW, SR = 8, 8.0, 16.0, 1.0, 16000
LIMIT, HOLD_BASE, PER_WORD, MEASURED, VOICE_MATCH = 0.3, 1.5, 0.3, 0.8, 0.7  # the user's rules; no flag loosens them


def toks(s: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", s.lower().replace("-", " ").replace("'", ""))


def band_cells(video: Path, box) -> np.ndarray:
    x, y, w, h = box
    w, h = w // BLK * BLK, h // BLK * BLK
    return np.stack([f.reshape(h // BLK, BLK, w // BLK, BLK, 3).mean(axis=(1, 3)).astype(np.float32)
                     for _, f in _media.decode(video, crop=(x, y, w, h))])


def caption_spans(cells: np.ndarray, blank: np.ndarray | None) -> list[tuple[int, int]]:
    hit = np.r_[0.0, np.abs(np.diff(cells, axis=0)).max(axis=(1, 2, 3))] > EVENT
    cuts = [0] + [f for f in range(1, len(cells)) if hit[f] and not hit[f - 1]] + [len(cells)]
    spans = []
    for a, b in zip(cuts, cuts[1:]):
        if spans and np.abs(cells[(a + b) // 2] - cells[sum(spans[-1]) // 2]).max() <= BLANK_MAX:
            a = spans.pop()[0]
        spans.append((a, b))
    return [(a, b) for a, b in spans if blank is None or np.abs(cells[(a + b) // 2] - blank).max() > BLANK_MAX]


def cues(video: Path) -> list[tuple[float, float, str]]:
    """Start, end and text of each cue in the export's first subtitle track (mov_text), read from the file."""
    srt = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-map", "0:s:0", "-f", "srt", "-"],
                         capture_output=True, text=True).stdout
    if not srt.strip():
        raise SystemExit(f"sync.py: {video} has no subtitle track to measure")
    t = r"(\d+):(\d+):(\d+)[,.](\d+)"
    sec = lambda h, m, s, ms: int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000  # noqa: E731
    return [(sec(*m[:4]), sec(*m[4:8]), " ".join(m[8].split()))
            for m in re.findall(t + " --> " + t + r"[^\n]*\n(.*?)(?:\n\n|\Z)", srt.replace("\r", ""), re.S)]


def onsets(a: np.ndarray) -> np.ndarray:
    out, run = [], 0
    for i, v in enumerate(_media.loudness_db(a, SR) >= -40.0):
        if not v:
            run += 1
        else:
            if run >= 8:
                out.append(i * 0.01)
            run = 0
    return np.array(out)


def from_video(video: Path) -> dict:
    """A timeline for an export with soft subtitles and no timeline: its own cues are the captions."""
    caps = [{"text": t, "show": s, "hide": e} for s, e, t in cues(video)]
    return {"video": str(video), "fps": _media.probe(video)["fps"], "captions": caps, "subtitles": True}


def from_voice(v: dict, video: Path, box: list[int]) -> dict:
    """A timeline for a composed film: voice.json's captions, burned into box of the export."""
    caps = [{"text": c["text"], "show": c["start"], "hide": c["end"]} for ln in v["lines"] for c in ln["captions"]]
    return {"video": str(video), "fps": _media.probe(video)["fps"], "captions": caps, "caption_box": box}


def run(d: dict, video: Path | None, out: Path, words_file: Path | None, profile: str = "narrated",
        voice: Path | None = None):
    video = video or Path(d["video"])
    caps, box = d.get("captions", []), d.get("caption_box")
    if not caps or not (box or d.get("subtitles")):
        raise SystemExit("sync.py: the timeline has no captions, or neither a caption_box nor subtitles")
    fps = d["fps"]
    if box:
        cells = band_cells(video, box)
        free = [f for f in range(len(cells)) if not any(c["show"] <= f / fps < c["hide"] for c in caps)]
        spans, texts, where = caption_spans(cells, np.median(cells[free], axis=0) if free else None), None, f"pixels of {box}"
    else:
        cue = cues(video)
        spans, texts = [(round(s * fps), round(e * fps)) for s, e, _ in cue], [t for *_, t in cue]
        where = "the export's own subtitle track"
    span, used = {}, -1
    for i, c in enumerate(caps):
        k = next((k for k, (f0, _) in enumerate(spans) if k > used and abs(f0 / fps - c["show"]) <= WINDOW
                  and (texts is None or texts[k] == " ".join(c["text"].split()))), None)
        if k is not None:
            used = k
            span[i] = spans[k]
    holds = []
    for i, c in enumerate(caps):
        need = HOLD_BASE + PER_WORD * len(c["text"].split())
        f0, f1 = span.get(i, (None, None))
        held = None if f0 is None else (f1 - f0) / fps
        notes = ["never shown" if held is None else f"{need - held:.2f} s short" if held + 0.5 / fps < need else "",
                 "" if re.search(r"[.!?…][\"'”’)\]]*$", c["text"].strip()) else "split mid-sentence"]
        holds.append({"i": i, "text": c["text"], "shown": None if f0 is None else f0 / fps, "held": held,
                      "need": round(need, 3), "note": "; ".join(n for n in notes if n)})
    bad_holds = [h for h in holds if h["note"]] if profile == "captions" else []
    tight = min((h for h in holds if h["held"] is not None), key=lambda h: h["held"] - h["need"], default=None)
    f = lambda v: "—" if v is None else f"{v:.3f}"  # noqa: E731
    md = ["# Caption checks on the export", "", f"Video: {video}. Captions: {where}. Profile: {profile}.", "",
          "## Holds", "", f"Each caption on screen at least {HOLD_BASE} s plus {PER_WORD} s per word, ending a sentence."
          if profile == "captions" else f"Each caption's hold against {HOLD_BASE} s plus {PER_WORD} s per word.",
          f"Captions shown: {len(span)} of {len(caps)}. Failing: {len(bad_holds)}. "
          + (f"Worst margin: {tight['held'] - tight['need']:+.2f} s at {f(tight['shown'])} s, '{tight['text'][:60]}'."
             if tight else "Worst margin: not measured."), "",
          "| # | Shown (s) | Held (s) | Needs (s) | Caption | Note |", "| --- | --- | --- | --- | --- | --- |",
          *[f"| {h['i']} | {f(h['shown'])} | {f(h['held'])} | {h['need']:.2f} | {h['text'][:70]} | {h['note']} |"
            for h in holds],
          "", f"Holds: {'PASS' if not bad_holds else 'FAIL'}" if profile == "captions"
          else "Holds: reported, not failed, because a narrated caption lasts as long as its spoken clause.", "",
          "## Sync", ""]
    report = {"video": str(video), "spans": spans, "holds": holds}
    out.mkdir(parents=True, exist_ok=True)
    if profile == "captions":
        md += ["Sync: not applicable (captions-only profile, no voice)."]
        ok_sync = None
    else:
        ok_sync, lines = sync(caps, {i: s[0] for i, s in span.items()}, fps, video, words_file, report, voice)
        md += lines
    md += ["", f"Verdict: {'PASS' if not bad_holds and ok_sync is not False else 'FAIL'}"]
    (out / "sync.json").write_text(json.dumps(report, indent=1))
    (out / "sync.md").write_text("\n".join(md) + "\n")
    return not bad_holds, ok_sync, [line for line in md if not line.startswith("| ")]


def sync(caps: list[dict], first: dict, fps: float, video: Path, words_file: Path | None, report: dict,
         voice: Path | None):
    if not _media.probe(video)["audio"]:
        raise SystemExit(f"sync.py: {video} has no audio to listen to; measure the mixed export (--video FINAL.mp4)")
    match = _media.voice_match(video, voice) if voice else None
    if voice and match < VOICE_MATCH:
        raise SystemExit(f"sync.py: {voice} is not the voice in {video}: their loudness over time correlates "
                         f"{match:.2f} at zero lag, under {VOICE_MATCH}; pass the voice track the export was mixed from")
    a = _media.samples(voice or video, SR)
    if words_file:
        heard, source = json.loads(Path(words_file).read_text()), f"word times from {words_file} (not heard from the export)"
    else:
        heard, source = _media.heard_words(a), "local faster-whisper on " + str(voice or "the export's audio")
    if voice:
        source += f", which matches the export's audio (loudness correlation {match:.2f})"
    ons = onsets(a)
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
    over = [r for r in scored if abs(r["offset"]) > LIMIT]
    missing = [r for r in rows if r["frame"] is None]
    ok = not over and not missing and len(scored) >= MEASURED * len(rows)
    report.update(words_source=source, rows=rows, heard=heard)
    worst = max(scored, key=lambda r: abs(r["offset"])) if scored else None
    f = lambda v: "—" if v is None else f"{v:.3f}"  # noqa: E731
    g = lambda v: "—" if v is None else f"{v:+.3f}"  # noqa: E731
    return ok, [f"Words: {source}.",
                f"Captions found: {len(rows) - len(missing)} of {len(rows)}. Scored: {len(scored)} of {len(rows)}, "
                f"at least {MEASURED:.0%} must be; over {LIMIT} s: {len(over)}.",
                f"Caption words heard in order: {agree} of {len(exp)} ({100 * agree / max(1, len(exp)):.1f} %), "
                "spelling agreement, not intelligibility.",
                (f"Worst offset: {worst['offset']:+.3f} s at {f(worst['shown'])} s, '{worst['text'][:60]}'." if worst
                 else "Worst offset: not measured."), "",
                "| # | First frame | Shown (s) | Speech onset (s) | Offset (s) | Caption | Note |",
                "| --- | --- | --- | --- | --- | --- | --- |",
                *[f"| {r['i']} | {r['frame'] if r['frame'] is not None else '—'} | {f(r['shown'])} | {f(r['onset'])} | "
                  f"{g(r['offset'])} | {r['text'][:70]} | {r['note']} |" for r in rows],
                "", "Human listening pass: not measured.", f"Sync: {'PASS' if ok else 'FAIL'}"]


def self_test() -> int:
    fails = []
    caps = [("Alpha one.", 0.5, 2.7), ("Bravo two.", 2.8, 5.0), ("Charlie three.", 5.6, 7.8)]
    fnt = _media.font(28)
    fps, secs = 30, 8.5
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        words = [{"w": w, "start": s + 0.05 + 0.3 * j, "end": s + 0.3 + 0.3 * j}
                 for t, s, _ in caps for j, w in enumerate(t.split())]
        (d / "words.json").write_text(json.dumps(words))
        (d / "early.json").write_text(json.dumps([{**w, "start": w["start"] - 0.6} for w in words]))
        t = np.arange(int(secs * SR)) / SR
        voice = 0.3 * np.sin(2 * np.pi * 220 * t) * np.any([(s <= t) & (t < e - 0.3) for _, s, e in caps], axis=0)
        _media.write_wav(d / "voice.wav", voice, SR)
        _media.write_wav(d / "mix.wav", voice + 0.05 * np.sin(2 * np.pi * 110 * t), SR)
        _media.write_wav(d / "bed.wav", 0.05 * np.sin(2 * np.pi * 110 * t), SR)
        (d / "none.json").write_text("[]")
        def check(name, video, planned, profile, words="words.json", voice=None, **tl):
            tl = {"video": str(video), "fps": fps, "canvas": [640, 360], "total": secs, "shots": [],
                  "captions": [{"text": t, "show": s, "hide": e} for t, s, e in planned], **tl}
            try:
                return run(tl, None, d / name, d / words, profile, voice=voice)[:2]
            except SystemExit:
                return "exit"
        def burned(name, shown, planned=caps, profile="narrated", fade=0, audio=d / "voice.wav", keyframe=secs, **kw):
            def frames():
                for k in range(int(secs * fps)):
                    img = Image.new("RGB", (640, 360), (226, 232, 240))
                    dr = ImageDraw.Draw(img)
                    dr.rectangle([20, 10, 620, 290], fill=(250, 250, 252))
                    if k / fps >= keyframe:  # the band 10 levels brighter, as an x264 keyframe redraws a still caption
                        dr.rectangle([0, 300, 640, 360], fill=(236, 242, 250))
                    for text, s, e in shown:
                        if s <= k / fps < e and not fade:
                            dr.rounded_rectangle([180, 305, 460, 350], 12, fill=(15, 23, 42))
                            dr.text((200, 310), text, font=fnt, fill=(255, 255, 255))
                        elif s <= k / fps < e:
                            ink = int(226 - 211 * min(1.0, (k + 1 - s * fps) / fade))
                            dr.text((200, 310), text, font=fnt, fill=(ink, ink, ink))
                    yield np.asarray(img)
            _media.write_video(d / f"{name}.mp4", frames(), 640, 360, fps, audio)
            return check(name, d / f"{name}.mp4", planned, profile, caption_box=[0, 300, 640, 60], **kw)
        def soft(name, shown):
            _media.write_video(d / f"{name}.mp4", (np.full((360, 640, 3), 240, np.uint8) for _ in range(int(secs * fps))),
                               640, 360, fps, d / "voice.wav")
            st = lambda t: f"00:00:{int(t):02d},{int(round(t % 1 * 1000)):03d}"  # noqa: E731
            (d / f"{name}.srt").write_text("".join(f"{i}\n{st(a)} --> {st(b)}\n{t}\n\n" for i, (t, a, b) in enumerate(shown, 1)))
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(d / f"{name}.mp4"), "-i", str(d / f"{name}.srt"),
                            "-map", "0", "-map", "1", "-c", "copy", "-c:s", "mov_text", str(d / f"{name}-s.mp4")], check=True)
            return d / f"{name}-s.mp4"
        late = [caps[0], ("Bravo two.", 3.4, 5.55), caps[2]]
        cases = [
            ("soft subtitles on their words", check("soft", soft("soft", caps), caps, "narrated", subtitles=True), (True, True)),
            ("a soft subtitle 0.6 s late", check("soft-late", soft("soft-late", late), caps, "narrated", subtitles=True),
             (True, False)),
            ("soft subtitles read with no timeline, one ending mid-sentence",
             run(from_video(soft("cues", [caps[0], ("Bravo two", 2.8, 5.0), caps[2]])), None, d / "cues", None,
                 "captions")[:2], (False, None)),
            ("a soft subtitle on time with the wrong words",
             check("soft-wrong", soft("soft-wrong", [caps[0], ("Delta four.", 2.8, 5.0), caps[2]]), caps, "narrated",
                   subtitles=True), (True, False)),
            ("captions shown on their words", burned("ontime", caps), (True, True)),
            ("thin text with no box, fading in over 4 frames", burned("thin", caps, fade=4), (True, True)),
            ("a caption 0.6 s late", burned("late", late), (True, False)),
            ("a keyframe redrawing a caption 0.6 s before the next one", burned("keyframe", caps, keyframe=2.2),
             (True, True)),
            ("captions-only, the same keyframe", burned("keyframe-c", caps, profile="captions", keyframe=2.2),
             (True, None)),
            ("a caption that never appears", burned("missing", [caps[0], caps[2]]), (True, False)),
            ("captions-only, a caption that never appears", burned("missing-c", [caps[0], caps[2]], profile="captions"),
             (False, None)),
            ("no caption's first word heard, so nothing measured", burned("deaf", caps, words="none.json"), (True, False)),
            ("an export with no audio", burned("mute", caps, audio=None), "exit"),
            ("--voice the narration, but the export carries only the bed",
             burned("no-voice", caps, audio=d / "bed.wav", voice=d / "voice.wav"), "exit"),
            ("voice.json's captions with --caption-box, shown on their words",
             run(from_voice({"lines": [{"captions": [{"text": t, "start": s, "end": e}]} for t, s, e in caps]},
                            d / "ontime.mp4", [0, 300, 640, 60]), None, d / "voice-json", d / "words.json")[:2],
             (True, True)),
            ("narrated, a clause held 1.4 s of the 2.1 s a caption would need",
             burned("clause", clause := [caps[0], ("Bravo two", 2.8, 4.2), caps[2]], clause), (True, True)),
            ("a music bed under the voice, words heard 0.6 s early, onsets from the mix",
             burned("bed", caps, audio=d / "mix.wav", words="early.json"), (True, False)),
            ("the same, onsets from --voice", burned("bed-voice", caps, audio=d / "mix.wav", words="early.json",
                                                     voice=d / "voice.wav"), (True, True)),
            ("captions-only, a caption held 1.4 s of the 2.1 s it needs",
             burned("short", [caps[0], ("Bravo two.", 2.8, 4.2), caps[2]], profile="captions"), (False, None)),
            ("captions-only, a caption already on screen at frame 0",
             burned("first", [("Alpha one.", 0.0, 2.7), *caps[1:]], [("Alpha one.", 0.0, 2.7), *caps[1:]], "captions"),
             (True, None)),
        ]
        fails += [f"{what}: holds and sync {got}, want {want}" for what, got, want in cases if got != want]
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
    unknown = [f for f in a[1::2] if f not in ("--profile", "--video", "--voice", "--out", "--caption-box")]
    if unknown or len(a) % 2 == 0:
        raise SystemExit(f"sync.py: unknown or incomplete arguments {unknown or a[-1:]}; see --help")
    src = Path(a[0]).resolve()
    profile = arg(a, "--profile", "narrated")
    if profile not in ("narrated", "captions"):
        raise SystemExit(f"sync.py: --profile is narrated or captions, not {profile}")
    d = json.loads(src.read_text()) if src.suffix == ".json" else from_video(src)
    video = Path(arg(a, "--video")).resolve() if "--video" in a else None
    if "chapters" in d:
        if not video or "--caption-box" not in a:
            raise SystemExit("sync.py: with voice.json, pass --video V.mp4 and --caption-box X,Y,W,H")
        d = from_voice(d, video, [int(v) for v in arg(a, "--caption-box").split(",")])
    voice = arg(a, "--voice", d.get("voice"))
    holds, synced, md = run(d, video, Path(arg(a, "--out", src.parent / "checks")), None, profile,
                            Path(voice).resolve() if voice else None)
    print("\n".join(md))
    return 0 if holds and synced is not False else 1


if __name__ == "__main__":
    sys.exit(main())
