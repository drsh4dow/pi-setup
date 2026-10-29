"""Shared helpers: the timeline contract, frame decoding by index, and synthetic media for self-tests.

The timeline (timeline.json) is the seam between any cutter and the checks. cut.py writes it; a cutter of
your own can write the same shape and every check still runs. All times are seconds, all boxes are
canvas pixels of the export unless named otherwise:

    {
      "video": "/abs/cut.mp4", "fps": 30, "canvas": [W, H], "total": 12.3,
      "shots": [{"take": "/abs/t1.mp4", "size": [w, h], "view": [x, y, vw, vh], "out0": 0.0, "out1": 6.0,
                 "pieces": [[o0, o1, "play", s0, s1, speed], [o0, o1, "hold", s0, null, 0]]}],
      "marks": [{"kind": "outline", "t0": 1.0, "t1": 2.5, "box": [x0, y0, x1, y1], "color": [r, g, b]},
                {"kind": "ring", "t0": 3.0, "t1": 3.65, "center": [x, y], "radius": 44}],
      "caption_box": [x, y, w, h] or null,
      "captions": [{"text": "...", "show": 0.25, "hide": 2.9}],
      "chips": [{"text": "26 s later", "t0": 4.0, "t1": 5.2, "box": [x, y, w, h]}],
      "lines": [{"text": "...", "start": 0.3, "end": 2.8}]
    }

A shot's view is where the take's whole viewport sits in the export; framing.py proves the pixels agree.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

SKILL = Path(__file__).resolve().parent.parent
FONT = SKILL.parent / "catchup-video" / "fonts" / "Inter-Regular.ttf"


def font(size: int, path: str | None = None) -> ImageFont.FreeTypeFont:
    p = Path(path) if path else FONT
    return ImageFont.truetype(str(p), size) if p.exists() else ImageFont.load_default(size=size)


def probe(path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                          "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    v = next(s for s in d["streams"] if s["codec_type"] == "video")
    num, den = (int(x) for x in v["avg_frame_rate"].split("/"))
    return {"w": v["width"], "h": v["height"], "fps": num / den if den else 0.0,
            "duration": float(d["format"]["duration"]),
            "audio": any(s["codec_type"] == "audio" for s in d["streams"])}


def decode(path, every: int = 1, crop: tuple | None = None):
    """Yield (frame index, HxWx3 uint8) for every `every`-th frame, selected by index, never resampled by time."""
    info = probe(path)
    w, h = info["w"], info["h"]
    vf = [f"select='not(mod(n\\,{every}))'"] if every > 1 else []
    if crop:
        x, y, cw, ch = crop
        vf.append(f"crop={cw}:{ch}:{x}:{y}")
        w, h = cw, ch
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v"]
    if vf:
        cmd += ["-vf", ",".join(vf)]
    cmd += ["-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size, n, done = w * h * 3, 0, False
    try:
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield n * every, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            n += 1
        done = True
    finally:
        if not done:  # the caller stopped early: end ffmpeg before it writes into a closed pipe
            proc.kill()
        proc.stdout.close()
        rc = proc.wait()
    if rc != 0:
        raise SystemExit(f"ffmpeg decode of {path} failed")


def frames_near(path, t: float, fps: float, w: int, h: int, n: int = 3) -> list[Image.Image]:
    """The take frames at t - 1/fps, t and t + 1/fps: a one-frame timing offset must not read as a mismatch."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t - 1 / fps):.4f}", "-i", str(path),
                          "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    size = w * h * 3
    return [Image.frombuffer("RGB", (w, h), raw[i:i + size], "raw", "RGB", 0, 1)
            for i in range(0, len(raw) - size + 1, size)]


class Timeline:
    def __init__(self, path):
        self.path = Path(path)
        self.d = json.loads(self.path.read_text())
        self.fps = self.d["fps"]
        self.W, self.H = self.d["canvas"]
        self.shots = self.d["shots"]

    @property
    def video(self) -> Path:
        return Path(self.d["video"])

    def shot_at(self, t: float) -> dict:
        for s in self.shots:
            if t < s["out1"]:
                return s
        return self.shots[-1]

    @staticmethod
    def src_at(shot: dict, t: float) -> float:
        last = shot["pieces"][-1]
        for o0, o1, kind, s0, s1, speed in shot["pieces"]:
            if t < o1 or [o0, o1] == last[:2]:
                return s0 if kind == "hold" else min(s1, s0 + max(0.0, t - o0) * speed)
        return last[3]

    def marks_at(self, t: float) -> list[dict]:
        return [m for m in self.d.get("marks", []) if m["t0"] <= t <= m["t1"]]


def view_mask(marks: list[dict], view: list, pad: int) -> np.ndarray:
    """Pixels of the view that the scheduled marks may change: each outline box or ring disc grown by pad."""
    vx, vy, vw, vh = view
    m = Image.new("L", (vw, vh), 0)
    d = ImageDraw.Draw(m)
    for mk in marks:
        if mk["kind"] == "outline":
            x0, y0, x1, y1 = mk["box"]
            d.rectangle([x0 - vx - pad, y0 - vy - pad, x1 - vx + pad, y1 - vy + pad], fill=255)
        elif mk["kind"] == "ring":
            cx, cy = mk["center"]
            r = mk["radius"] + pad
            d.ellipse([cx - vx - r, cy - vy - r, cx - vx + r, cy - vy + r], fill=255)
    return np.asarray(m) > 0


def write_video(path, frames, w: int, h: int, fps: int, audio: Path | None = None) -> None:
    """Encode an iterable of HxWx3 uint8 frames to H.264, with an optional audio file muxed in."""
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps),
           "-i", "-"]
    if audio:
        cmd += ["-i", str(audio), "-c:a", "aac", "-b:a", "160k", "-shortest"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", str(path)]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames:
        enc.stdin.write(np.ascontiguousarray(f, np.uint8).tobytes())
    enc.stdin.close()
    if enc.wait() != 0:
        raise SystemExit(f"encode of {path} failed")


def synth_page(w: int, h: int, t: float, fps: int) -> np.ndarray:
    """A page-like synthetic frame: header bar, text rows, a frame counter block, and a moving pointer dot."""
    img = Image.new("RGB", (w, h), (250, 250, 252))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, h // 10], fill=(30, 64, 120))
    for i in range(8):
        y = h // 10 + 20 + i * (h // 12)
        d.rectangle([24, y, 24 + (w // 2) + (i * 37) % (w // 3), y + h // 40], fill=(120, 130, 150))
    k = int(round(t * fps))
    d.rectangle([w - 90, h - 50, w - 20, h - 20], fill=((k * 7) % 256, 80, 160))
    px, py = int(w * 0.2 + (w * 0.6) * ((t * 0.3) % 1)), int(h * 0.6)
    d.ellipse([px - 6, py - 6, px + 6, py + 6], fill=(0, 0, 0))
    return np.asarray(img)


def synth_take(path, w: int, h: int, seconds: float, fps: int = 30) -> None:
    write_video(path, (synth_page(w, h, k / fps, fps) for k in range(int(seconds * fps))), w, h, fps)
