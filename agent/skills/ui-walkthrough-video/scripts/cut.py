#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Cut recorded takes into one video: every take's whole viewport at one scale in one slot, words only in
boxes outside that slot, and over the page nothing but click rings and outline highlights.

    cut.py EDIT.json              # render; writes the video, timeline.json and transcript.md beside EDIT.json
    cut.py EDIT.json --still T    # still-T.png: one composed frame at output time T (layout review, no render)
    cut.py --self-test            # renders a synthetic cut, runs framing.py and overlays.py on it, exits 0 on pass

EDIT.json (paths relative to it; every box is [x, y, w, h] in canvas pixels unless named otherwise):

    {"out": "cut.mp4", "fps": 30, "canvas": [1920, 1080], "background": [226, 232, 240],
     "page": {"slot": [200, 8, 1520, 950], "scale": null},  # null: the largest scale that fits every take
     "frame": {"color": [100, 116, 139], "width": 2},        # optional outline around the slot
     "caption_box": [0, 962, 1920, 118], "caption_size": 34, "caption_rows": 2,
     "chip_box": [1730, 20, 180, 48],                         # where "N s later" goes; null when no chips
     "labels": [{"box": [8, 20, 184, 40], "text": "Chapter 1", "t0": 0, "t1": 9}],
     "font": null,                                            # default: catchup-video's Inter
     "tts": {"cache": "tts", "offline": false},               # null: no voice; each line then needs "dur"
     "shots": [{"take": "takes/t1.mp4",                       # events default: takes/t1.events.json
                "pieces": [{"play": [0, 4]}, {"hold": 4, "for": 1.5}, {"play": [30, 34], "chip": "auto"}],
                "outlines": [{"src": [1, 3], "mark": "save", "key": "box", "color": [37, 99, 235]},
                             {"src": [5, 7], "box": [100, 200, 300, 40]}],   # take pixels
                "rings": true}],
     "lines": [{"text": "Caption text.", "say": "what the voice says", "at": 0.3}]}

A piece plays take seconds [s0, s1] at "speed" (default 1), or holds one take frame "for" seconds. Consecutive
pieces that skip take time are a jump cut; "chip": "auto" on the later piece shows "N s later" in chip_box.
A line's "at" is the output time its first word starts. Rings come from the take's logged clicks. Outlines
come from a logged DOM box ("mark", "key") or a literal take-pixel box; they cover the take seconds "src".

Rules the cutter enforces (exit 2): one scale for every take; every text box outside the page slot; captions
fit caption_rows; narration lines don't overlap and end before the picture does.
"""
from __future__ import annotations

import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

SR = 48000
CAPTION_LEAD, CAPTION_TAIL = 0.05, 0.25
RING_DUR, RING_MAX = 0.65, 44
OUTLINE_PAD, OUTLINE_W, FADE = 4, 3, 0.2
CHIP_FOR = 1.2


class EditError(SystemExit):
    def __init__(self, msg: str):
        super().__init__(f"cut.py: {msg}")
        self.code = 2


def inter(a, b) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


class Take:
    def __init__(self, path: Path, events: Path | None):
        self.path = path
        info = _media.probe(path)
        self.w, self.h, self.fps = info["w"], info["h"], info["fps"] or 30
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


def plan_pieces(shot: dict, t: float) -> tuple[list, list]:
    pieces, chips, prev_end = [], [], None
    for p in shot["pieces"]:
        if "play" in p:
            s0, s1 = map(float, p["play"])
            sp = float(p.get("speed", 1.0))
            dur = (s1 - s0) / sp
            if dur <= 0:
                raise EditError(f"piece {p} plays nothing")
            if p.get("chip"):
                text = p["chip"]
                if text == "auto":
                    if prev_end is None or s0 <= prev_end:
                        raise EditError(f"chip 'auto' on {p} needs an earlier piece that ends before {s0}")
                    text = f"{round(s0 - prev_end)} s later"
                chips.append({"text": text, "t0": t, "t1": t + CHIP_FOR})
            pieces.append([t, t + dur, "play", s0, s1, sp])
            t, prev_end = t + dur, s1
        else:
            s = float(p["hold"])
            pieces.append([t, t + float(p["for"]), "hold", s, None, 0])
            t, prev_end = t + float(p["for"]), s
    return pieces, chips


def out_first(pieces, src) -> float | None:
    for o0, o1, kind, s0, s1, sp in pieces:
        if kind == "play" and s0 <= src <= s1:
            return o0 + (src - s0) / sp
        if kind == "hold" and abs(s0 - src) < 1e-6:
            return o0
    return None


def out_last(pieces, src) -> float | None:
    best = None
    for o0, o1, kind, s0, s1, sp in pieces:
        if kind == "hold" and s0 <= src + 1e-6:
            best = o1
        elif kind == "play" and s0 <= src + 1e-6:
            best = o1 if src >= s1 else o0 + (src - s0) / sp
    return best


def chunks_of(text: str, times: list[tuple[float, float]], max_chars: int) -> list[dict]:
    words, out, cur = text.split(), [], []
    for i, w in enumerate(words):
        cur.append(i)
        joined = " ".join(words[j] for j in cur)
        if re.search(r"[.?!:]$", w) or len(joined) > max_chars or i == len(words) - 1:
            out.append({"text": joined, "start": times[cur[0]][0], "end": times[cur[-1]][1]})
            cur = []
    return out


def word_times(line: dict, clip: dict | None) -> list[tuple[float, float]]:
    words = line["text"].split()
    if clip and len(clip["words"]) == len(words):
        vs = clip["voiced_start"]
        return [(line["start"] + w["start"] - vs, line["start"] + w["end"] - vs) for w in clip["words"]]
    # spoken words differ from caption words (a "say" override) or no voice: spread by characters
    total = sum(len(w) + 1 for w in words)
    out, acc, span = [], 0, line["end"] - line["start"]
    for w in words:
        a = line["start"] + span * acc / total
        acc += len(w) + 1
        out.append((a, line["start"] + span * acc / total))
    return out


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
        self.takes = {}
        for s in e["shots"]:
            tp = (self.root / s["take"]).resolve()
            ev = self.root / s["events"] if "events" in s else tp.with_suffix(".events.json")
            self.takes.setdefault(str(tp), Take(tp, ev))
        sx, sy, sw, sh = self.slot
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
        e, t = self.e, 0.0
        self.shots, self.marks, self.chips = [], [], []
        for s in e["shots"]:
            tk = self.takes[str((self.root / s["take"]).resolve())]
            pieces, chips = plan_pieces(s, t)
            view = self.view(tk)
            for c in chips:
                self.chips.append(c | {"box": e.get("chip_box")})
                if not e.get("chip_box"):
                    raise EditError("a piece asks for a chip but chip_box is null")
            for o in s.get("outlines", []):
                t0, t1 = out_first(pieces, o["src"][0]), out_last(pieces, o["src"][1])
                if t0 is None or t1 is None or t1 <= t0:
                    raise EditError(f"outline {o} covers take time this shot never shows")
                x, y, w, h = tk.rect(o)
                sc, (vx, vy) = self.scale, view[:2]
                self.marks.append({"kind": "outline", "t0": t0, "t1": t1, "color": o.get("color", [37, 99, 235]),
                                   "box": [vx + x * sc - OUTLINE_PAD, vy + y * sc - OUTLINE_PAD,
                                           vx + (x + w) * sc + OUTLINE_PAD, vy + (y + h) * sc + OUTLINE_PAD]})
            if s.get("rings", True):
                for c in tk.clicks:
                    tc = out_first(pieces, c["t"])
                    if tc is not None:
                        self.marks.append({"kind": "ring", "t0": tc, "t1": tc + RING_DUR,
                                           "color": s.get("ring_color", [37, 99, 235]),
                                           "center": [view[0] + c["x"] * tk.k * self.scale,
                                                      view[1] + c["y"] * tk.k * self.scale],
                                           "radius": RING_MAX + 3})
            self.shots.append({"take": str(tk.path), "size": [tk.w, tk.h], "view": view, "out0": t,
                               "out1": pieces[-1][1], "pieces": pieces, "_tk": tk})
            t = pieces[-1][1]
        self.total = t
        self.plan_lines()

    def plan_lines(self):
        tts_cfg = self.e.get("tts")
        synth = None
        if tts_cfg:
            import tts  # noqa: PLC0415
            cache = self.root / tts_cfg.get("cache", "tts")
            synth = lambda say: tts.synth(say, cache, offline=tts_cfg.get("offline", False))  # noqa: E731
        self.lines, prev_end = [], -1.0
        for ln in self.e.get("lines", []):
            clip = synth(ln.get("say", ln["text"])) if synth else None
            dur = clip["voiced_end"] - clip["voiced_start"] if clip else float(ln["dur"]) if "dur" in ln else None
            if dur is None:
                raise EditError(f"line '{ln['text'][:40]}' has no voice and no dur")
            start = float(ln["at"])
            if start < prev_end + 0.1:
                raise EditError(f"line '{ln['text'][:40]}' starts at {start:.2f}, before the last one ends ({prev_end:.2f})")
            if start + dur > self.total:
                raise EditError(f"line '{ln['text'][:40]}' ends at {start + dur:.2f}, after the picture ({self.total:.2f}); "
                                "add a hold")
            line = {"text": ln["text"], "say": ln.get("say", ln["text"]), "start": start, "end": start + dur, "clip": clip}
            self.lines.append(line)
            prev_end = line["end"]
        self.captions = []
        if self.e.get("caption_box"):
            d = ImageDraw.Draw(Image.new("RGB", (8, 8)))
            bx, by, bw, bh = self.e["caption_box"]
            rows = int(self.e.get("caption_rows", 2))
            for ln in self.lines:
                for c in chunks_of(ln["text"], word_times(ln, ln["clip"]), int(self.e.get("caption_chars", 90))):
                    if len(wrap(d, c["text"], self.f_cap, bw - 80)) > rows:
                        raise EditError(f"caption wraps past {rows} rows: '{c['text'][:60]}'; cut words")
                    self.captions.append(c | {"show": max(0.0, c["start"] - CAPTION_LEAD)})
            # a caption hides at the next one's show time, so an old caption's tail never holds the next one back
            for i, c in enumerate(self.captions):
                hide = c["end"] + CAPTION_TAIL
                if i + 1 < len(self.captions):
                    hide = min(hide, self.captions[i + 1]["show"])
                c["hide"] = min(hide, self.total)

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
        cap = next((i for i, c in enumerate(self.captions) if c["show"] <= t < c["hide"]), None)
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
    def narration(self, dest: Path) -> None:
        n = int(math.ceil(self.total * SR))
        buf = np.zeros(n, np.float32)
        for ln in self.lines:
            clip = ln["clip"]
            if not clip:
                continue
            pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", clip["wav"], "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
                                 capture_output=True, check=True).stdout
            a = np.frombuffer(pcm, np.float32)
            a = a[max(0, int((clip["voiced_start"] - 0.06) * SR)):int((clip["voiced_end"] + 0.12) * SR)].copy()
            f = min(len(a), int(0.02 * SR))
            a[:f] *= np.linspace(0, 1, f)
            a[len(a) - f:] *= np.linspace(1, 0, f)
            at = int((ln["start"] - 0.06) * SR)
            if at < 0:
                a, at = a[-at:], 0
            end = min(n, at + len(a))
            buf[at:end] += a[:end - at]
        raw = dest.with_suffix(".raw.wav")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", str(raw)],
                       input=buf.tobytes(), check=True)
        if not any(ln["clip"] for ln in self.lines):
            raw.replace(dest)
            return
        meas = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(raw), "-af",
                               "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                              capture_output=True, text=True).stderr
        m = json.loads(meas[meas.rindex("{"):meas.rindex("}") + 1])
        af = (f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
              f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-af", af, "-ar", str(SR), str(dest)], check=True)
        raw.unlink()

    def timeline(self) -> dict:
        return {"video": str(self.out), "fps": self.fps, "canvas": [self.W, self.H], "total": self.total,
                "scale": self.scale, "slot": self.slot,
                "shots": [{k: v for k, v in s.items() if k != "_tk"} for s in self.shots],
                "marks": self.marks, "caption_box": self.e.get("caption_box"),
                "captions": [{k: c[k] for k in ("text", "show", "hide")} for c in self.captions],
                "chips": self.chips,
                "lines": [{"text": ln["text"], "say": ln["say"], "start": ln["start"], "end": ln["end"]} for ln in self.lines]}

    def render(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "narration.wav"
            self.narration(wav)
            _media.write_video(self.out, self.frames(), self.W, self.H, self.fps, audio=wav)
        (self.out.parent / "timeline.json").write_text(json.dumps(self.timeline(), indent=1))
        fmt = lambda t: f"{int(t // 60)}:{t % 60:05.2f}"  # noqa: E731
        rows = [f"# {self.out.name} transcript", "", "| Start | End | Line |", "| --- | --- | --- |"]
        rows += [f"| {fmt(ln['start'])} | {fmt(ln['end'])} | {ln['text']} |" for ln in self.lines]
        (self.out.parent / "transcript.md").write_text("\n".join(rows) + "\n")

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
        (d / "takes").mkdir()
        _media.synth_take(d / "takes" / "t1.mp4", 640, 400, 6.0)
        _media.synth_take(d / "takes" / "t2.mp4", 480, 400, 3.0)   # a narrower take: same scale, centred
        (d / "takes" / "t1.events.json").write_text(json.dumps({"take": "t1", "width": 640, "height": 400, "events": [
            {"t": 1.0, "kind": "click", "x": 320, "y": 200, "label": "save"},
            {"t": 0.5, "kind": "mark", "label": "row", "box": {"x": 24, "y": 60, "w": 300, "h": 12}}]}))
        edit = {"out": "cut.mp4", "fps": 30, "canvas": [960, 600], "page": {"slot": [140, 10, 800, 500]},
                "frame": {"color": [100, 116, 139], "width": 2}, "caption_box": [0, 516, 960, 84], "caption_size": 24,
                "chip_box": [8, 20, 124, 36], "labels": [{"box": [8, 70, 124, 60], "text": "Synthetic", "t0": 0, "t1": 99}],
                "shots": [{"take": "takes/t1.mp4", "pieces": [{"play": [0, 2]}, {"hold": 2, "for": 0.6},
                                                               {"play": [4, 6], "chip": "auto"}],
                           "outlines": [{"src": [0.4, 1.8], "mark": "row"}]},
                          {"take": "takes/t2.mp4", "pieces": [{"play": [0, 2]}]}],
                "lines": [{"text": "A synthetic page. A row is outlined.", "at": 0.2, "dur": 2.0},
                          {"text": "Two seconds later, a narrower take.", "at": 2.9, "dur": 2.4}]}
        ep = d / "edit.json"
        ep.write_text(json.dumps(edit))
        fails = []
        c = Cut(ep)
        c.render()
        tl = json.loads((d / "timeline.json").read_text())
        if abs(tl["scale"] - 1.25) > 1e-9:
            fails.append(f"scale {tl['scale']} != 1.25 (the largest that fits 640x400 in 800x500)")
        if [s["view"] for s in tl["shots"]] != [[140, 10, 800, 500], [240, 10, 600, 500]]:
            fails.append(f"views {[s['view'] for s in tl['shots']]}")
        if [ch["text"] for ch in tl["chips"]] != ["2 s later"]:
            fails.append(f"chips {tl['chips']}")
        caps = tl["captions"]
        if len(caps) != 3 or any(a["hide"] > b["show"] + 1e-9 for a, b in zip(caps, caps[1:])):
            fails.append(f"captions overlap or miscount: {caps}")
        if not any(m["kind"] == "ring" for m in tl["marks"]) or not any(m["kind"] == "outline" for m in tl["marks"]):
            fails.append("missing ring or outline mark")
        for script in ("framing.py", "overlays.py"):
            r = subprocess.run([sys.executable, str(here / script), str(d / "timeline.json"), "--out", str(d / "checks")],
                               capture_output=True, text=True)
            if r.returncode != 0:
                fails.append(f"{script} exit {r.returncode}: {r.stdout[-600:]}{r.stderr[-600:]}")
        bad = dict(edit, caption_box=[0, 400, 960, 200])
        ep.write_text(json.dumps(bad))
        try:
            Cut(ep)
            fails.append("a caption box over the page slot was accepted")
        except SystemExit as e:
            if e.code != 2:
                fails.append(f"caption box over the page: exit {e.code}, want 2")
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
