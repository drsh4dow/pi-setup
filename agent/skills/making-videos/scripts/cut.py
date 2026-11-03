#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Cut recorded takes into one video: every take's whole viewport at one scale in one slot, words only in
boxes outside that slot, and over the page nothing but click rings and outline highlights.

    cut.py EDIT.json              # render; writes the video, its voice track, timeline.json and transcript.md
    cut.py EDIT.json --still T    # still-T.png: one composed frame at output time T (layout review, no render)
    cut.py --self-test            # renders synthetic cuts, runs framing.py, overlays.py and sync.py on them

EDIT.json (paths relative to it; every box is [x, y, w, h] in canvas pixels unless named otherwise):

    {"out": "cut.mp4", "fps": 30, "canvas": [1920, 1080], "background": [226, 232, 240],
     "page": {"slot": [200, 8, 1520, 950], "scale": null},  # null: the largest scale that fits every take
     "frame": {"color": [100, 116, 139], "width": 2},        # optional outline around the slot
     "caption_box": [0, 962, 1920, 118], "caption_size": 34, "caption_rows": 2,   # null: nothing burned in
     "subtitles": false,                  # true: captions as a mov_text track in the mp4 and an .srt beside it
     "chip_box": [1730, 20, 180, 48],                         # where "N s later" goes; null when no chips
     "labels": [{"box": [8, 20, 184, 40], "text": "Chapter 1", "t0": 0, "t1": 9}],
     "font": null,                                            # default: the skill's fonts/Inter-Regular.ttf
     "voice": "voice/voice.json",                             # narrate.py's output; narration.wav beside it
     "chapter": null,                                         # null: every chapter; an id: that chapter alone
     "shots": [{"take": "takes/t1.mp4", "chapter": "intro",   # events default: takes/t1.events.json
                "pieces": [{"play": [0.5, 4]}, {"play": [30, 34], "chip": "auto"}],
                "outlines": [{"src": [1, 3], "mark": "save", "key": "box", "color": [37, 99, 235]},
                             {"src": [5, 7], "box": [100, 200, 300, 40]}],   # take pixels
                "rings": true}]}

A piece plays take seconds [s0, s1] at 1.0x, and nothing else: no speed ramps, no freeze holds. Consecutive
pieces that skip take time are a jump cut; "chip": "auto" on the later piece shows "N s later" in chip_box.
Rings come from the take's logged clicks. Outlines come from a logged DOM box ("mark", "key") or a literal
take-pixel box; they cover the take seconds "src".

The voice: with "chapter": null the cut plays voice.json and narration.wav on their own clock. With a chapter
id it plays that chapter alone, moved so its window starts the cut: the one-chapter preview. Either way the
voice track is written beside the video as <out>-voice.wav and named in timeline.json. The video itself has
no audio: mix.sh puts the voice (and any music) in at -16 LUFS.

Timing a take to the voice. A chapter's window starts on voice.json's clock halfway between the end of the
chapter before it and its own start (at 0 for the first chapter), and runs to the next window. A take for that chapter waits a lead of L s, then
fires the action for a word at

    L + (word t - window start) + the seconds of every earlier wait the shot jump-cuts,

and its shot starts with {"play": [L, ...]}. Jump-cut a wait exactly: the piece ends where the logged wait
starts and the next piece starts where it ends. Each shot names its chapter; the first shot of a chapter
starts at its window, and cut.py ends the shot before it there. So a take driven by this rule lines up with
no hand fixing, in the full cut and in its chapter's preview alike.

Rules the cutter enforces (exit 2): pieces only play, inside their take; one scale for every take; the slot
inside the canvas; every text box outside the slot; captions fit caption_rows; every shot names a chapter this
cut voices, in voice order, and the shots before a chapter reach its window; the voice ends before the picture.
"""
from __future__ import annotations

import contextlib
import io
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

SR = 48000
CAPTION_LEAD = 0.05
RING_DUR, RING_MAX = 0.65, 44
OUTLINE_PAD, OUTLINE_W, FADE = 4, 3, 0.2
CHIP_FOR = 1.2


class EditError(SystemExit):
    def __init__(self, msg: str):
        print(f"cut.py: {msg}", file=sys.stderr)  # SystemExit prints nothing once its code is the number 2
        super().__init__(2)


def inter(a, b) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


class Take:
    def __init__(self, path: Path, events: Path | None):
        self.path = path
        info = _media.probe(path)
        self.w, self.h, self.fps, self.duration = info["w"], info["h"], info["fps"] or 30, info["duration"]
        ev = json.loads(events.read_text()) if events and events.exists() else {"events": []}
        k = self.w / ev.get("width", self.w)  # viewport CSS px to take px
        self.k = k
        self.clicks = [e for e in ev["events"] if e["kind"] == "click"]
        self.marks = {e["label"]: e for e in ev["events"] if e["kind"] == "mark"}

    def rect(self, o: dict) -> list[float]:
        if "box" in o:
            return [float(v) for v in o["box"]]
        b = self.marks[o["mark"]][o.get("key", "box")]
        return [b["x"] * self.k, b["y"] * self.k, b["w"] * self.k, b["h"] * self.k]


def plan_pieces(shot: dict, t: float, tk: Take) -> tuple[list, list]:
    pieces, chips, prev_end = [], [], None
    for p in shot["pieces"]:
        if "play" not in p or set(p) - {"play", "chip"}:
            raise EditError(f"piece {p}: a piece only plays take seconds at 1.0x, as {{\"play\": [s0, s1]}} with an "
                            "optional chip; speed ramps and freeze holds are gone, so jump-cut over a real wait instead")
        s0, s1 = map(float, p["play"])
        if s1 <= s0:
            raise EditError(f"piece {p} plays nothing")
        if s0 < 0 or s1 > tk.duration + 0.5 / tk.fps:
            raise EditError(f"piece {p} plays outside {tk.path.name}, which runs 0 to {tk.duration:.2f} s; "
                            "past its end the last frame would repeat as a freeze hold")
        if p.get("chip"):
            text = p["chip"]
            if text == "auto":
                if prev_end is None or s0 <= prev_end:
                    raise EditError(f"chip 'auto' on {p} needs an earlier piece that ends before {s0}")
                text = f"{round(s0 - prev_end)} s later"
            chips.append({"text": text, "t0": t, "t1": t + CHIP_FOR})
        pieces.append([t, t + s1 - s0, s0, s1])  # the timeline piece shape _media.Timeline reads
        t, prev_end = t + s1 - s0, s1
    return pieces, chips


def end_at(pieces: list, t: float) -> None:
    """Cut a shot's pieces short so the shot ends at output time t."""
    while pieces[-1][0] >= t:
        pieces.pop()
    o0, _, s0, _ = pieces[-1]
    pieces[-1][1:] = [t, s0, s0 + t - o0]


def out_first(pieces, src) -> float | None:
    return next((o0 + src - s0 for o0, _, s0, s1 in pieces if s0 <= src <= s1), None)


def out_last(pieces, src) -> float | None:
    best = None
    for o0, o1, s0, s1 in pieces:
        if s0 <= src + 1e-6:
            best = o1 if src >= s1 else o0 + src - s0
    return best


def srt_time(t: float) -> str:
    ms = round(t * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def wrap(d: ImageDraw.ImageDraw, text: str, fnt, max_w: float) -> list[str]:
    rows, cur = [], ""
    for w in text.split():
        trial = f"{cur} {w}".strip()
        if d.textlength(trial, font=fnt) <= max_w or not cur:
            cur = trial
        else:
            rows.append(cur)
            cur = w
    return rows + ([cur] if cur else [])


class Cut:
    def __init__(self, edit_path: Path):
        self.root = edit_path.parent
        e = self.e = json.loads(edit_path.read_text())
        self.fps = int(e.get("fps", 30))
        self.W, self.H = e.get("canvas", [1920, 1080])
        self.out = (self.root / e.get("out", "cut.mp4")).resolve()
        self.font_path = e.get("font")
        self.f_cap = _media.font(int(e.get("caption_size", 34)), self.font_path)
        self.f_chip = _media.font(22, self.font_path)
        self.f_label = _media.font(18, self.font_path)
        self.slot = e["page"]["slot"]
        sx, sy, sw, sh = self.slot
        if sx < 0 or sy < 0 or sx + sw > self.W or sy + sh > self.H:
            raise EditError(f"page slot {self.slot} is not inside the {self.W}x{self.H} canvas: it would crop the page")
        self.takes = {}
        for s in e["shots"]:
            tp = (self.root / s["take"]).resolve()
            ev = self.root / s["events"] if "events" in s else tp.with_suffix(".events.json")
            self.takes.setdefault(str(tp), Take(tp, ev))
        fit = min(min(sw / t.w, sh / t.h) for t in self.takes.values())
        self.scale = float(e["page"].get("scale") or fit)
        if self.scale > fit + 1e-9:
            raise EditError(f"scale {self.scale} does not fit every take's whole viewport in the slot (max {fit:.4f})")
        for name, box in self.text_boxes():
            if inter(box, self.slot):
                raise EditError(f"{name} {box} overlaps the page slot {self.slot}: words go around the page, never on it")
        self.plan()

    def text_boxes(self):
        for k in ("caption_box", "chip_box"):
            if self.e.get(k):
                yield k, self.e[k]
        for lb in self.e.get("labels", []):
            yield f"label '{lb['text']}'", lb["box"]

    def view(self, tk: Take) -> list[int]:
        sx, sy, sw, sh = self.slot
        vw, vh = round(tk.w * self.scale), round(tk.h * self.scale)
        return [sx + (sw - vw) // 2, sy + (sh - vh) // 2, vw, vh]

    # ------------------------------------------------------------------ plan
    def plan(self):
        e = self.e
        vpath = self.root / e["voice"]
        voice = json.loads(vpath.read_text())
        self.voice_wav, self.voice_out = vpath.parent / "narration.wav", self.out.with_name(self.out.stem + "-voice.wav")
        chs = voice["chapters"]
        b = [0.0] + [(p["end"] + c["start"]) / 2 for p, c in zip(chs, chs[1:])] + [voice["duration"]]
        starts = {c["id"]: b[i] for i, c in enumerate(chs)}   # each chapter's window start, on voice.json's clock
        pick = e.get("chapter")
        if pick is not None and pick not in starts:
            raise EditError(f"chapter '{pick}' is not in {vpath}")
        i = list(starts).index(pick) if pick else None
        self.lo, self.hi = (b[i], b[i + 1]) if pick else (0.0, voice["duration"])  # the voice.json span the cut plays
        starts = {pick: 0.0} if pick else starts
        t, self.shots, self.chips = 0.0, [], []
        for s in e["shots"]:
            tk = self.takes[str((self.root / s["take"]).resolve())]
            ch = s.get("chapter")
            if ch not in starts:
                raise EditError(f"shot {s['take']} names chapter {ch!r}; each shot names one this cut voices: {list(starts)}")
            if not self.shots or ch != self.shots[-1]["_chapter"]:
                want = starts[ch]
                if self.shots and want <= self.shots[-1]["out0"]:
                    raise EditError(f"chapter '{ch}' starts at {want:.2f} s, before the shot before it; order shots by chapter")
                if t < want - 1e-6:
                    raise EditError(f"chapter '{ch}' starts at {want:.2f} s on the output clock, but the shots before it "
                                    f"end at {t:.2f} s; play more take time, or give each earlier chapter its shot")
                if self.shots:
                    end_at(self.shots[-1]["pieces"], want)
                    self.shots[-1]["out1"] = want
                    self.chips = [c for c in self.chips if c["t0"] < want]
                t = want
            pieces, chips = plan_pieces(s, t, tk)
            if chips and not e.get("chip_box"):
                raise EditError("a piece asks for a chip but chip_box is null")
            self.chips += [c | {"box": e.get("chip_box")} for c in chips]
            self.shots.append({"take": str(tk.path), "_chapter": ch, "size": [tk.w, tk.h], "view": self.view(tk),
                               "out0": t, "out1": pieces[-1][1], "pieces": pieces, "_tk": tk, "_edit": s})
            t = pieces[-1][1]
        self.total = t
        self.marks = [m for shot in self.shots for m in self.shot_marks(shot)]
        self.lines = [ln | {"start": ln["start"] - self.lo, "end": ln["end"] - self.lo}
                      for ln in voice["lines"] if pick in (None, ln["chapter"])]
        if self.lines[-1]["end"] > self.total:
            raise EditError(f"the voice ends at {self.lines[-1]['end']:.2f} s, after the picture ({self.total:.2f} s); "
                            "play more take time")
        self.plan_captions()

    def shot_marks(self, shot: dict) -> list[dict]:
        s, tk, pieces, view, sc = shot["_edit"], shot["_tk"], shot["pieces"], shot["view"], self.scale
        marks = []
        for o in s.get("outlines", []):
            t0, t1 = out_first(pieces, o["src"][0]), out_last(pieces, o["src"][1])
            if t0 is None or t1 is None or t1 <= t0:
                raise EditError(f"outline {o} covers take time this shot never shows")
            x, y, w, h = tk.rect(o)
            vx, vy = view[:2]
            marks.append({"kind": "outline", "t0": t0, "t1": t1, "color": o.get("color", [37, 99, 235]),
                          "box": [vx + x * sc - OUTLINE_PAD, vy + y * sc - OUTLINE_PAD,
                                  vx + (x + w) * sc + OUTLINE_PAD, vy + (y + h) * sc + OUTLINE_PAD]})
        if s.get("rings", True):
            for c in tk.clicks:
                tc = out_first(pieces, c["t"])
                if tc is not None:
                    marks.append({"kind": "ring", "t0": tc, "t1": tc + RING_DUR, "color": s.get("ring_color", [37, 99, 235]),
                                  "center": [view[0] + c["x"] * tk.k * sc, view[1] + c["y"] * tk.k * sc],
                                  "radius": RING_MAX + 3})
        return marks

    def plan_captions(self):
        self.captions = [{"text": c["text"], "start": c["start"] - self.lo, "end": c["end"] - self.lo}
                         for ln in self.lines for c in ln["captions"]] if self.e.get("caption_box") or self.e.get("subtitles") else []
        d = ImageDraw.Draw(Image.new("RGB", (8, 8)))
        rows = int(self.e.get("caption_rows", 2))
        for c in self.captions:
            if self.e.get("caption_box") and len(wrap(d, c["text"], self.f_cap, self.e["caption_box"][2] - 80)) > rows:
                raise EditError(f"caption wraps past {rows} rows: '{c['text'][:60]}'; cut words")
            c["show"] = max(0.0, c["start"] - CAPTION_LEAD)
        for i, c in enumerate(self.captions):
            nxt = self.captions[i + 1]["show"] if i + 1 < len(self.captions) else self.total
            c["hide"] = min(c["end"], nxt, self.total)

    # ------------------------------------------------------------------ draw
    def base(self) -> Image.Image:
        img = Image.new("RGBA", (self.W, self.H), tuple(self.e.get("background", [226, 232, 240])) + (255,))
        d = ImageDraw.Draw(img)
        fr = self.e.get("frame")
        sx, sy, sw, sh = self.slot
        if fr:
            b = int(fr.get("width", 2))
            d.rectangle([sx - b, sy - b, sx + sw + b - 1, sy + sh + b - 1], fill=tuple(fr["color"]))
        d.rectangle([sx, sy, sx + sw - 1, sy + sh - 1], fill=tuple(self.e.get("slot_fill", [203, 213, 225])))
        return img

    def words_layer(self, t: float) -> tuple[tuple, Image.Image | None]:
        cap = None if not self.e.get("caption_box") else next(
            (i for i, c in enumerate(self.captions) if c["show"] <= t < c["hide"]), None)
        chip = next((i for i, c in enumerate(self.chips) if c["t0"] <= t < c["t1"]), None)
        labels = tuple(i for i, lb in enumerate(self.e.get("labels", [])) if lb.get("t0", 0) <= t < lb.get("t1", 1e9))
        key = (cap, chip, labels)
        if key == (None, None, ()):
            return key, None
        top = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
        d = ImageDraw.Draw(top)
        if cap is not None:
            bx, by, bw, bh = self.e["caption_box"]
            rows = wrap(d, self.captions[cap]["text"], self.f_cap, bw - 80)
            lh = self.f_cap.size * 1.3
            th = lh * len(rows) + 20
            y0 = by + (bh - th) / 2
            mw = max(d.textlength(r, font=self.f_cap) for r in rows)
            d.rounded_rectangle([bx + (bw - mw) / 2 - 28, y0, bx + (bw + mw) / 2 + 28, y0 + th], 16, fill=(15, 23, 42, 222))
            for i, r in enumerate(rows):
                d.text((bx + (bw - d.textlength(r, font=self.f_cap)) / 2, y0 + 8 + lh * i), r, font=self.f_cap,
                       fill=(255, 255, 255))
        if chip is not None:
            x, y, w, h = self.chips[chip]["box"]
            d.rounded_rectangle([x, y, x + w, y + h], h // 2, fill=(15, 23, 42, 230))
            txt = self.chips[chip]["text"]
            d.text((x + (w - d.textlength(txt, font=self.f_chip)) / 2, y + (h - self.f_chip.size) / 2 - 2), txt,
                   font=self.f_chip, fill=(255, 255, 255))
        for i in labels:
            lb = self.e["labels"][i]
            x, y, w, h = lb["box"]
            for j, r in enumerate(wrap(d, lb["text"], self.f_label, w)):
                d.text((x, y + j * self.f_label.size * 1.3), r, font=self.f_label, fill=(30, 41, 59))
        return key, top

    def page_marks(self, view_img: Image.Image, view: list, t: float) -> Image.Image:
        marks = [m for m in self.marks if m["t0"] <= t <= m["t1"]]
        if not marks:
            return view_img
        ov = Image.new("RGBA", view_img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(ov)
        vx, vy = view[:2]
        for m in marks:
            col = tuple(m["color"])
            if m["kind"] == "outline":
                a = min(1.0, (t - m["t0"]) / FADE, (m["t1"] - t) / FADE)
                x0, y0, x1, y1 = m["box"]
                d.rounded_rectangle([x0 - vx, y0 - vy, x1 - vx, y1 - vy], 8, outline=col + (int(235 * a),), width=OUTLINE_W)
            else:
                q = (t - m["t0"]) / RING_DUR
                r = 10 + (RING_MAX - 10) * (1 - (1 - q) ** 2)
                cx, cy = m["center"][0] - vx, m["center"][1] - vy
                d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col + (int(220 * (1 - q)),), width=5)
                d.ellipse([cx - 9, cy - 9, cx + 9, cy + 9], fill=col + (int(90 * (1 - q)),))
        return Image.alpha_composite(view_img.convert("RGBA"), ov)

    def compose(self, base, cache, shot, frame: Image.Image, t: float) -> np.ndarray:
        vx, vy, vw, vh = shot["view"]
        view = self.page_marks(frame.resize((vw, vh), Image.LANCZOS), shot["view"], t)
        canvas = base.copy()
        canvas.paste(view.convert("RGBA"), (vx, vy))
        key, top = self.words_layer(t)
        if top is not None:
            if key not in cache:
                cache.clear()
                cache[key] = top
            canvas = Image.alpha_composite(canvas, cache[key])
        return np.asarray(canvas.convert("RGB"))

    def frames(self):
        base, cache = self.base(), {}
        n = int(math.ceil(self.total * self.fps - 1e-6))
        si, dec = 0, None
        for k in range(n):
            t = k / self.fps
            while si + 1 < len(self.shots) and t >= self.shots[si]["out1"]:
                si, dec = si + 1, None
            shot = self.shots[si]
            src = _media.Timeline.src_at(shot, t)
            if dec is None or not dec.can(src):
                dec = Decoder(shot["_tk"], src)
            yield self.compose(base, cache, shot, dec.get(src), t)

    # ------------------------------------------------------------------ audio, docs
    def timeline(self) -> dict:
        return {"video": str(self.out), "fps": self.fps, "canvas": [self.W, self.H], "total": self.total,
                "scale": self.scale, "slot": self.slot,
                "shots": [{k: v for k, v in s.items() if not k.startswith("_")} for s in self.shots],
                "marks": self.marks, "caption_box": self.e.get("caption_box"),
                "subtitles": str(self.out.with_suffix(".srt")) if self.e.get("subtitles") else None,
                "captions": [{k: c[k] for k in ("text", "show", "hide")} for c in self.captions],
                "chips": self.chips, "voice": str(self.voice_out),
                "lines": [{"text": ln["show"], "start": ln["start"], "end": ln["end"]} for ln in self.lines]}

    def render(self) -> None:
        a = _media.samples(self.voice_wav, SR)[int(self.lo * SR):int(min(self.hi, self.lo + self.total) * SR)]
        _media.write_wav(self.voice_out, np.pad(a, (0, max(0, math.ceil(self.total * SR) - len(a)))), SR)
        _media.write_video(self.out, self.frames(), self.W, self.H, self.fps)
        if self.e.get("subtitles"):
            self.mux_subtitles()
        (self.out.parent / "timeline.json").write_text(json.dumps(self.timeline(), indent=1))
        fmt = lambda t: f"{int(t // 60)}:{t % 60:05.2f}"  # noqa: E731
        rows = [f"# {self.out.name} transcript", "", "| Start | End | Line |", "| --- | --- | --- |"]
        rows += [f"| {fmt(ln['start'])} | {fmt(ln['end'])} | {ln['show']} |" for ln in self.lines]
        (self.out.parent / "transcript.md").write_text("\n".join(rows) + "\n")

    def mux_subtitles(self) -> None:
        """Captions as a toggleable mov_text track in the mp4 plus an .srt beside it; nothing burned in."""
        srt = self.out.with_suffix(".srt")
        srt.write_text("".join(f"{i}\n{srt_time(c['show'])} --> {srt_time(c['hide'])}\n{c['text']}\n\n"
                               for i, c in enumerate(self.captions, 1)))
        tmp = self.out.with_suffix(".subs.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(self.out), "-i", str(srt), "-map", "0", "-map", "1",
                        "-c", "copy", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", "-disposition:s:0",
                        "default", "-movflags", "+faststart", str(tmp)], check=True)
        tmp.replace(self.out)

    def still(self, t: float) -> Path:
        shot = next((s for s in self.shots if t < s["out1"]), self.shots[-1])
        src = _media.Timeline.src_at(shot, t)
        tk = shot["_tk"]
        frame = _media.frames_near(tk.path, src + 1 / tk.fps, tk.fps, tk.w, tk.h, 1)[0]
        dest = self.out.parent / f"still-{t:07.2f}.png"
        Image.fromarray(self.compose(self.base(), {}, shot, frame, t)).save(dest)
        return dest


class Decoder:
    """Sequential take decoder; restarts when a piece jumps backwards in take time."""

    def __init__(self, tk: Take, start: float):
        self.tk, self.start, self.idx, self.frame = tk, start, -1, None
        self.size = tk.w * tk.h * 3
        self.proc = subprocess.Popen(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(tk.path), "-f", "rawvideo",
                                      "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)

    def can(self, src: float) -> bool:
        return round((src - self.start) * self.tk.fps) >= self.idx

    def get(self, src: float) -> Image.Image:
        want = max(0, round((src - self.start) * self.tk.fps))
        while self.idx < want:
            buf = self.proc.stdout.read(self.size)
            if len(buf) < self.size:
                break
            self.frame, self.idx = buf, self.idx + 1
        if self.frame is None:
            raise SystemExit(f"cut.py: no frame at {src:.2f} s in {self.tk.path}")
        return Image.frombuffer("RGB", (self.tk.w, self.tk.h), self.frame, "raw", "RGB", 0, 1)

    def __del__(self):
        if getattr(self, "proc", None):
            self.proc.kill()
            self.proc.wait()


# ---------------------------------------------------------------------- self-test
def self_test() -> int:
    here = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "script.json").write_text(json.dumps([
            {"id": "a", "chapter": "one", "show": "A synthetic page."},
            {"id": "b1", "chapter": "two", "show": "A narrower take."},
            {"id": "b2", "chapter": "two", "show": "Saved after the wait."}]))
        subprocess.run([str(here / "narrate.py"), str(d / "script.json"), "--voice", "captions"], check=True,
                       capture_output=True)
        voice = json.loads((d / "voice.json").read_text())
        t = np.arange(int(voice["duration"] * SR)) / SR
        _media.write_wav(d / "narration.wav", sum(0.3 * np.sin(2 * np.pi * 220 * t) * ((t >= ln["start"]) & (t < ln["end"]))
                                                   for ln in voice["lines"]), SR)
        word = {w["w"].strip("."): w["t"] for ln in voice["lines"] for w in ln["words"]}
        one, nxt = voice["chapters"]
        two = (one["end"] + nxt["start"]) / 2  # chapter two's window starts halfway through the quiet before it
        lead, wait = 1.0, (2.6, 6.6)       # take t2 waits 1 s, then a backend wait from 2.6 s to 6.6 s
        (d / "takes").mkdir()
        _media.synth_take(d / "takes" / "t1.mp4", 640, 400, 6.0)
        _media.synth_take(d / "takes" / "t2.mp4", 480, 400, 11.5)   # a narrower take: same scale, centred
        (d / "takes" / "t1.events.json").write_text(json.dumps({"width": 640, "height": 400, "events": [
            {"t": 0.5 + word["synthetic"], "kind": "click", "x": 320, "y": 200, "label": "save"},
            {"t": 0.5, "kind": "mark", "label": "row", "box": {"x": 24, "y": 60, "w": 300, "h": 12}}]}))
        (d / "takes" / "t2.events.json").write_text(json.dumps({"width": 480, "height": 400, "events": [
            {"t": lead + word["narrower"] - two, "kind": "click", "x": 100, "y": 100, "label": "before the wait"},
            {"t": lead + word["after"] - two + wait[1] - wait[0], "kind": "click", "x": 300, "y": 300, "label": "after"}]}))
        t1 = {"take": "takes/t1.mp4", "chapter": "one", "pieces": [{"play": [0.5, 6]}],
              "outlines": [{"src": [0.6, 1.8], "mark": "row"}]}
        t2 = {"take": "takes/t2.mp4", "chapter": "two",
              "pieces": [{"play": [lead, wait[0]]}, {"play": [wait[1], 11.5], "chip": "auto"}]}
        edit = {"out": "cut.mp4", "fps": 30, "canvas": [960, 600], "page": {"slot": [140, 10, 800, 500]},
                "frame": {"color": [100, 116, 139], "width": 2}, "caption_box": [0, 516, 960, 84], "caption_size": 24,
                "chip_box": [8, 20, 124, 36], "labels": [{"box": [8, 70, 124, 60], "text": "Synthetic", "t0": 0, "t1": 99}],
                "voice": "voice.json", "chapter": None, "shots": [t1, t2]}
        ep = d / "edit.json"
        fails = []

        def render(e: dict) -> dict:
            ep.write_text(json.dumps(e))
            Cut(ep).render()
            return json.loads((d / "timeline.json").read_text())

        def near(got, want, what):
            if len(got) != len(want) or any(abs(g - w) > 1.01 / 30 for g, w in zip(got, want)):
                fails.append(f"{what} at {[round(g, 3) for g in got]} s, want {[round(w, 3) for w in want]}")

        def rises(wav: str) -> list[float]:
            a = _media.samples(d / wav, SR)
            sound = np.abs(a[:len(a) // 480 * 480]).reshape(-1, 480).max(axis=1) > 0.05
            return list((np.flatnonzero(np.diff(np.r_[0, sound.astype(int)]) == 1)) / 100)

        tl = render(edit)
        near(rises("cut-voice.wav"), [ln["start"] for ln in voice["lines"]], "the full cut's voice rises")
        near([t for s in tl["shots"] for t in (s["out0"], s["out1"])], [0, two, two, two + 1.6 + 4.9],
             "the full cut's shots, chapter one's cut short at chapter two's window,")
        near([m["t0"] for m in tl["marks"] if m["kind"] == "ring"], [word["synthetic"], word["narrower"], word["after"]],
             "rings of clicks fired by the timing rule")
        if tl["voice"] != str(d / "cut-voice.wav") or _media.probe(d / "cut.mp4")["audio"]:
            fails.append(f"voice track {tl['voice']}, or the video carries audio before mix.sh")
        if abs(tl["scale"] - 1.25) > 1e-9:
            fails.append(f"scale {tl['scale']} != 1.25 (the largest that fits 640x400 in 800x500)")
        if [s["view"] for s in tl["shots"]] != [[140, 10, 800, 500], [240, 10, 600, 500]]:
            fails.append(f"views {[s['view'] for s in tl['shots']]}")
        if [ch["text"] for ch in tl["chips"]] != ["4 s later"]:
            fails.append(f"chips {tl['chips']}")
        if not any(m["kind"] == "outline" for m in tl["marks"]):
            fails.append("missing outline mark")
        for script in ("framing.py", "overlays.py", "sync.py"):
            r = subprocess.run([sys.executable, str(here / script), str(d / "timeline.json"), "--out", str(d / "checks"),
                                *(["--profile", "captions"] if script == "sync.py" else [])], capture_output=True, text=True)
            if r.returncode != 0 or (script == "sync.py" and "Captions shown: 3 of 3" not in r.stdout):
                fails.append(f"{script} exit {r.returncode}: {r.stdout[-600:]}{r.stderr[-600:]}")

        tl = render(dict(edit, chapter="two", shots=[t2]))
        near(rises("cut-voice.wav"), [voice["lines"][1]["start"] - two, voice["lines"][2]["start"] - two],
             "chapter two's preview voice rises")
        near([m["t0"] for m in tl["marks"] if m["kind"] == "ring"], [word["narrower"] - two, word["after"] - two],
             "chapter two's preview rings")

        tl = render(dict(edit, out="full.mp4", canvas=[640, 400], page={"slot": [0, 0, 640, 400], "scale": 1.0}, frame=None,
                         caption_box=None, chip_box=None, labels=[], subtitles=True, chapter="one", shots=[t1]))
        subs = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "s", "-show_entries", "stream=codec_name",
                               "-of", "csv=p=0", str(d / "full.mp4")], capture_output=True, text=True).stdout.split()
        srt = (d / "full.srt").read_text() if (d / "full.srt").exists() else ""
        if subs[:1] != ["mov_text"] or "A synthetic page." not in srt or "00:00:00,400 -->" not in srt:
            fails.append(f"soft subtitles: streams {subs}, srt {srt[:80]!r}")
        if tl["scale"] != 1.0:
            fails.append("a full-canvas slot at scale 1.0 did not keep native pixels")
        if srt_time(1.9999999) != "00:00:02,000" or srt_time(3661.25) != "01:01:01,250":
            fails.append(f"srt times {srt_time(1.9999999)}, {srt_time(3661.25)}")

        def shot1(**kw):
            return dict(edit, shots=[dict(t1, **kw), t2])
        for bad, why, says in ((dict(edit, caption_box=[0, 400, 960, 200]), "a caption box over the page slot", "slot"),
                               (dict(edit, page={"slot": [-100, 10, 800, 500]}), "a slot off the canvas", "canvas"),
                               (dict(edit, chapter="nope"), "a chapter voice.json does not have", "nope"),
                               (dict(edit, shots=[t1, t2, t1]), "shots out of chapter order", "order"),
                               (dict(edit, chapter="two"), "a preview with another chapter's shot", "'one'"),
                               (shot1(pieces=[{"play": [0.5, 2]}]), "a shot that ends before the next window", "play more"),
                               (shot1(pieces=[{"play": [0.5, 7]}]), "a piece past the take's end", "freeze hold"),
                               (shot1(pieces=[{"play": [0, 2], "speed": 2}]), "a sped-up piece", "1.0x"),
                               (shot1(pieces=[{"play": [0, 2]}, {"hold": 2, "for": 1}]), "a freeze hold", "1.0x")):
            ep.write_text(json.dumps(bad))
            err = io.StringIO()
            try:
                with contextlib.redirect_stderr(err):
                    Cut(ep)
                fails.append(f"{why} was accepted")
            except SystemExit as e:
                if e.code != 2 or says not in err.getvalue():
                    fails.append(f"{why}: exit {e.code} saying {err.getvalue()!r}, want 2 saying {says!r}")
    print("cut.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    c = Cut(Path(a[0]).resolve())
    if "--still" in a:
        for t in a[a.index("--still") + 1:]:
            print(c.still(float(t)))
        return 0
    c.render()
    print(f"{c.out} ({c.total:.2f} s, scale {c.scale:.4f}); timeline.json and transcript.md beside it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
