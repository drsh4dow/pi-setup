#!/usr/bin/env python3
"""Full-window takes: the whole browser window (tabs, address bar and page) at native pixels, captured at the
OS level, driven by real OS pointer and key events. CDP screencast (agent-browser record) sees only the page,
so a take that must show the browser itself records an X display instead.

The window runs on its own virtual X display (Xvfb), so the user's desktop is never captured and no
screen-share consent prompt is needed. Chromium is headed there on its own profile with a CDP port, so
agent-browser can attach for DOM boxes, waits and the mask.

    window.py up --display :99 --size 1920x1080 --port 9333 --profile DIR [--url URL]   # Xvfb + Chromium
    window.py down --display :99 --profile DIR       # stops only the Xvfb and Chromium that `up` started
    window.py shot --display :99 --out FILE.png      # one frame of the display, as a take would see it
    window.py --self-test                            # a real Xvfb + Chromium round trip on a free display

Sign-in: copy the site's cookies from a signed-in agent browser over CDP (Storage.getCookies there,
Storage.setCookies here), or sign in once by hand in the window. Never copy from the user's daily browser.

As a module (stdlib only), WindowTake is drive.py's Take with an OS-level recorder and OS-level input:

    sys.path.insert(0, "<skill dir>/scripts"); from window import WindowTake
    t = WindowTake("c1", session="walk", out_dir="takes", display=":99", width=1920, height=1080,
                   mask_js="<skill dir>/scripts/mask.js")   # agent-browser --session walk connect 9333 first
    with t:                                   # ffmpeg x11grab starts; the clock starts at its first frame
        t.click(t.by_text("button", "Save"), "Save")       # DOM box -> window pixels -> xdotool

Every box, click and mark is logged in window pixels (page CSS px plus the browser chrome's offset), and
events.json width and height are the window's, so cut.py outlines and rings land on the recorded pixels.
Pointer moves are eased and stepped at about 60 Hz inside one xdotool process; typing is one xdotool key
event per character, 60-140 ms apart; scrolls are wheel button clicks at the pointer, WHEEL_PX each, so dy rounds to whole clicks. Needs Xvfb, xdotool,
ffmpeg (x11grab), agent-browser and Chromium ($CHROMIUM, default chromium).
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from drive import Take, run_ab  # noqa: E402

CHROMIUM = os.environ.get("CHROMIUM", "chromium")
WHEEL_PX = 120  # Chromium on X11 scrolls 120 CSS px per wheel button click at scale 1 (measured, Chromium 14x)


def xdo(display: str, *args: str, timeout: float = 60) -> str:
    r = subprocess.run(["xdotool", *args], capture_output=True, text=True, timeout=timeout,
                       env={**os.environ, "DISPLAY": display})
    if r.returncode != 0:
        raise RuntimeError(f"xdotool {' '.join(args[:2])} failed: {r.stderr[-300:]}")
    return r.stdout.strip()


def grab(display: str, out: Path, w: int, h: int) -> Path:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-video_size", f"{w}x{h}",
                    "-i", f"{display}.0", "-frames:v", "1", str(out)], check=True, timeout=30)
    return out


# ---------------------------------------------------------------------- the window
def up(display: str, w: int, h: int, port: int, profile: Path, url: str = "about:blank") -> dict:
    profile.mkdir(parents=True, exist_ok=True)
    pids = profile / "uiw-window.json"
    if pids.exists():
        raise SystemExit(f"window.py: {pids} exists; run `window.py down` first")
    if Path(f"/tmp/.X11-unix/X{display.lstrip(':')}").exists():
        raise SystemExit(f"window.py: display {display} is taken; pick another")
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", f"{w}x{h}x24", "-nolisten", "tcp"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):
        if Path(f"/tmp/.X11-unix/X{display.lstrip(':')}").exists():
            break
        time.sleep(0.1)
    chrome = subprocess.Popen([CHROMIUM, "--ozone-platform=x11", f"--user-data-dir={profile}", "--no-first-run",
                               "--no-default-browser-check", "--password-store=basic", f"--remote-debugging-port={port}",
                               "--window-position=0,0", f"--window-size={w},{h}", "--force-device-scale-factor=1",
                               "--disable-features=Translate,MediaRouter", "--hide-crash-restore-bubble", url],
                              env={**os.environ, "DISPLAY": display}, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, start_new_session=True)
    pids.write_text(json.dumps({"display": display, "xvfb": xvfb.pid, "chromium": chrome.pid, "port": port}))
    win = None
    for _ in range(100):
        try:
            win = xdo(display, "search", "--onlyvisible", "--class", "chromium").splitlines()[0]
            break
        except (RuntimeError, IndexError):
            time.sleep(0.2)
    if not win:
        down(display, profile)
        raise SystemExit("window.py: Chromium opened no window on the display")
    time.sleep(0.5)
    # Chromium opens a pixel short of --window-size; size and place it exactly, with no window manager to undo it
    xdo(display, "windowsize", win, str(w), str(h))
    xdo(display, "windowmove", win, "0", "0")
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1).read()
            break
        except OSError:
            time.sleep(0.2)
    return {"display": display, "window": win, "port": port, "size": [w, h], "xvfb": xvfb.pid, "chromium": chrome.pid}


def down(display: str, profile: Path) -> None:
    pids = profile / "uiw-window.json"
    if not pids.exists():
        return
    p = json.loads(pids.read_text())
    for k in ("chromium", "xvfb"):
        try:
            os.killpg(p[k], signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    time.sleep(0.5)
    pids.unlink()


# ---------------------------------------------------------------------- the take
class WindowTake(Take):
    """drive.py's Take, recording the whole window with ffmpeg x11grab and driving it with xdotool."""

    def __init__(self, name: str, session: str, out_dir, display: str = ":99", width: int = 1920, height: int = 1080,
                 fps: int = 30, mask_js=None, mask_terms: list[str] | None = None, wheel_px: int = WHEEL_PX,
                 runner=run_ab):
        super().__init__(name, session, out_dir, width, height, fps, mask_js, mask_terms, page_match="", runner=runner)
        self.display, self.wheel_px = display, wheel_px
        self.rec: subprocess.Popen | None = None
        self.offset = (0, 0)

    def x(self, *args: str) -> str:
        return xdo(self.display, *args)

    def page_offset(self) -> tuple[int, int]:
        """Window pixels of the page's top-left: the browser chrome sits above it."""
        g = self.js("JSON.stringify({x:screenX+outerWidth-innerWidth,y:screenY+outerHeight-innerHeight,"
                    "w:outerWidth,h:outerHeight,dpr:devicePixelRatio})")
        if g["dpr"] != 1:
            raise RuntimeError(f"devicePixelRatio {g['dpr']}: start the window with --force-device-scale-factor=1")
        return int(g["x"]), int(g["y"])

    def box(self, js_expr: str) -> dict:
        b = super().box(js_expr)
        return {"x": b["x"] + self.offset[0], "y": b["y"] + self.offset[1], "w": b["w"], "h": b["h"]}

    def start(self) -> None:
        if self.mask_terms:
            self.ab("eval", f"window.__uiwMaskTerms={json.dumps(self.mask_terms)}")
        if self.mask_js:
            self.ab("eval", Path(self.mask_js).read_text())
        self.offset = self.page_offset()
        loc = self.x("getmouselocation", "--shell")
        mx, my = (int(line.split("=")[1]) for line in loc.splitlines()[:2])
        self.mouse = (mx, my)
        time.sleep(0.3)
        self.out.mkdir(parents=True, exist_ok=True)
        mp4 = (self.out / f"{self.name}.mp4").resolve()
        launched = time.time()
        self.rec = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "x11grab",
                                     "-draw_mouse", "1", "-framerate", str(self.fps), "-video_size",
                                     f"{self.width}x{self.height}", "-i", f"{self.display}.0", "-c:v", "libx264",
                                     "-preset", "veryfast", "-tune", "zerolatency", "-crf", "16", "-pix_fmt", "yuv420p", "-progress", "pipe:1",
                                     "-stats_period", "0.1", str(mp4)],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        while True:  # the clock starts at the first captured frame, not at the launch
            line = self.rec.stdout.readline()
            if not line:
                raise RuntimeError(f"x11grab ended before its first frame: {self.rec.stderr.read()[-300:]}")
            if line.startswith("frame=") and int(line.split("=")[1]) > 0:
                n = int(line.split("=")[1])
                self.t0 = time.time() - n / self.fps
                break
            if time.time() - launched > 10:
                raise RuntimeError("x11grab wrote no frame in 10 s")
        threading_drain(self.rec.stdout)
        self.recorded_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        self.log("record_start", display=self.display, offset=list(self.offset))

    def stop(self) -> Path:
        self.log("record_stop")
        if self.rec and self.rec.poll() is None:
            self.rec.stdin.write("q")
            self.rec.stdin.flush()
            try:
                self.rec.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.rec.send_signal(signal.SIGINT)
                self.rec.wait(timeout=10)
        return self.save()

    # ---- pointer: real X pointer events --------------------------------------
    def move(self, x: float, y: float, dur: int | None = None) -> None:
        x, y = int(x), int(y)
        x0, y0 = self.mouse
        dist = math.hypot(x - x0, y - y0)
        if dist < 2:  # already there: a click after a hover must not wait out a move
            return
        dur = dur or int(min(900, max(280 if dist > 60 else 120, dist * 0.9)))
        steps = max(8, dur // 16)
        bow = self.rng.uniform(-0.08, 0.08) * dist  # a slight arc, as a hand draws it
        cmd: list[str] = []
        for i in range(1, steps + 1):
            q = i / steps
            e = q * q * (3 - 2 * q)
            px = x0 + (x - x0) * e - (y - y0) / max(dist, 1) * bow * math.sin(math.pi * q)
            py = y0 + (y - y0) * e + (x - x0) / max(dist, 1) * bow * math.sin(math.pi * q)
            cmd += ["mousemove", str(round(px)), str(round(py)), "sleep", f"{dur / steps / 1000:.3f}"]
        cmd += ["mousemove", str(x), str(y)]
        self.x(*cmd)
        self.mouse = (x, y)

    def click_xy(self, x: float, y: float, label: str, hold: float = 0.08, chrome: bool = False) -> None:
        """chrome=True allows a click on the browser's own tabs or address bar; otherwise one is an error, because
        it means the box was measured before a scroll or a layout shift moved the element away."""
        if not chrome and not (self.offset[1] <= y < self.height and 0 <= x < self.width):
            raise RuntimeError(f"click at {int(x)},{int(y)} for '{label}' is outside the page area")
        self.move(x, y)
        time.sleep(0.12)
        self.log("click", x=int(x), y=int(y), label=label)
        self.x("mousedown", "1", "sleep", f"{hold:.2f}", "mouseup", "1")

    def drag(self, x0, y0, x1, y1, label: str, dur: int = 700) -> None:
        self.move(x0, y0)
        time.sleep(0.15)
        self.log("drag", x=int(x0), y=int(y0), x1=int(x1), y1=int(y1), label=label)
        self.x("mousedown", "1")
        self.move(x1, y1, dur=dur)
        time.sleep(0.1)
        self.x("mouseup", "1")

    def wheel(self, dy: int, steps: int, horizontal: bool = False) -> None:
        clicks = max(1, round(abs(dy) / self.wheel_px))
        btn = ("7" if dy > 0 else "6") if horizontal else ("5" if dy > 0 else "4")
        # one repeat click: a chain of click and sleep commands costs about 90 ms more per click in xdotool
        self.x("click", "--repeat", str(clicks), "--delay", str(int(self.rng.uniform(45, 70))), btn)

    def scroll(self, dy: int, label: str = "scroll") -> None:
        self.log("scroll", dy=dy, label=label)
        self.wheel(dy, 0)
        time.sleep(0.3)

    def hscroll(self, dx: int, label: str = "scroll sideways") -> None:
        """A sideways wheel (X buttons 6 and 7), as a trackpad swipe sends: dx > 0 scrolls right."""
        self.log("scroll", dx=dx, label=label)
        self.wheel(dx, 0, horizontal=True)
        time.sleep(0.3)

    # ---- keyboard: real X key events -----------------------------------------
    def type(self, text: str, label: str, gap: tuple[float, float] = (0.06, 0.14)) -> None:
        """gap: the pause range between keys; the default reads as steady typing, (0.04, 0.09) as a fast typist."""
        self.log("type_start", label=label, chars=len(text))
        for ch in text:
            if ch == "\n":
                self.x("key", "Return")
            else:
                self.x("type", "--delay", "0", ch)
            time.sleep(self.rng.uniform(*gap))
        self.log("type_end", label=label)

    def press(self, key: str, label: str | None = None) -> None:
        keymap = {"Enter": "Return", "Escape": "Escape", "Backspace": "BackSpace", "Tab": "Tab"}
        self.log("key", key=key, label=label or key)
        self.x("key", keymap.get(key, key))

    def paste(self, text: str, label: str) -> None:
        raise NotImplementedError("paste skips the keyboard; type instead in a window take")


def threading_drain(stream) -> None:
    """Keep reading ffmpeg's progress pipe so it never blocks on a full pipe."""
    import threading

    threading.Thread(target=lambda: [None for _ in stream], daemon=True).start()


# ---------------------------------------------------------------------- self-test
PAGE = """<!doctype html><html><body style="margin:0;background:#f0f4f8;font:16px sans-serif">
<input id=f style="position:absolute;left:40px;top:40px;width:300px;height:30px">
<button id=b style="position:absolute;left:400px;top:120px;width:160px;height:50px"
 onclick="window.hits=(window.hits||[]).concat([[event.clientX,event.clientY]])">Save</button>
<div style="height:3000px;width:3000px"></div></body></html>"""


def self_test() -> int:
    fails: list[str] = []
    for tool in ("Xvfb", "xdotool", "ffmpeg", "agent-browser", CHROMIUM):
        if not shutil.which(tool):
            print(f"window.py self-test: FAIL\n  {tool} is not installed")
            return 1
    disp = next(f":{n}" for n in range(140, 200) if not Path(f"/tmp/.X11-unix/X{n}").exists())
    port = 9400 + int(disp[1:])
    sess = f"uiw-window-selftest-{os.getpid()}"
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(os.environ.get("UIW_KEEP") or tmp)
        d.mkdir(parents=True, exist_ok=True)
        (d / "page.html").write_text(PAGE)
        try:
            up(disp, 960, 640, port, d / "profile", f"file://{d / 'page.html'}")
            time.sleep(1.5)
            run_ab(["--session", sess, "connect", str(port)])
            t = WindowTake("w1", sess, d / "takes", display=disp, width=960, height=640)
            with t:
                t.mark_box("save", "document.getElementById('b')")
                t.click("document.getElementById('f')", "field")
                t.type("synthetic", "field")
                t.click("document.getElementById('b')", "Save")
                t.scroll(400)
                t.hscroll(240)
                t.pause(0.6)
                t.log("flash")
                t.js("document.body.style.background = 'rgb(255, 0, 0)'")
                t.pause(0.8)
            got = t.js("JSON.stringify({v:document.getElementById('f').value,h:window.hits||[],y:scrollY,x:scrollX})")
            ev = json.loads((d / "takes" / "w1.events.json").read_text())
            if got["v"] != "synthetic":
                fails.append(f"typed value {got['v']!r}, want 'synthetic' (OS key events did not land)")
            if got["h"] != [[480, 145]]:
                fails.append(f"button clicks at {got['h']}, want one at its centre 480,145 (page px)")
            if abs(got["y"] - 360) > 1:
                fails.append(f"scrollY {got['y']} after a 400 px wheel scroll, want 360 (3 clicks of {WHEEL_PX} px)")
            if abs(got["x"] - 240) > 1:
                fails.append(f"scrollX {got['x']} after a 240 px sideways scroll, want 240 (2 clicks of {WHEEL_PX} px)")
            try:
                t.click_xy(100, 20, "the address bar")
                fails.append("a click on the browser chrome was allowed without chrome=True")
            except RuntimeError:
                pass
            mark = next(e for e in ev["events"] if e["kind"] == "mark")["box"]
            click = [e for e in ev["events"] if e["kind"] == "click"][-1]
            off = ev["events"][0]["offset"] if ev["events"][0]["kind"] == "record_start" else None
            if not off or off[1] < 40:
                fails.append(f"page offset {off}: the browser chrome above the page was not measured")
            elif (mark["x"], mark["y"]) != (400 + off[0], 120 + off[1]) or (click["x"], click["y"]) != (480 + off[0], 145 + off[1]):
                fails.append(f"mark {mark} or click {click} not in window pixels (offset {off})")
            info = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                                   "stream=width,height,nb_read_frames", "-of", "json", str(d / "takes" / "w1.mp4")],
                                  capture_output=True, text=True).stdout
            st = json.loads(info)["streams"][0]
            if (st["width"], st["height"]) != (960, 640) or int(st["nb_read_frames"]) < 30:
                fails.append(f"take is {st}, want 960x640 with >= 30 frames")
            # the take's clock must match its frames: the first red frame shows within a frame or two of the logged flash
            flash = next(e["t"] for e in ev["events"] if e["kind"] == "flash")
            px = subprocess.run(["ffmpeg", "-v", "error", "-i", str(d / "takes" / "w1.mp4"), "-vf", "crop=2:2:900:600",
                                 "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
            red = next((i for i in range(len(px) // 12) if px[12 * i] > 200 and px[12 * i + 1] < 60), None)
            if red is None or abs(red / 30 - flash) > 0.1:
                fails.append(f"first red frame at {None if red is None else round(red / 30, 3)} s, flash logged at {flash} s:"
                             " the events clock and the video disagree")
            png = grab(disp, d / "shot.png", 960, 640)
            from PIL import Image  # noqa: PLC0415  (only the self-test needs it)
            im = Image.open(png).convert("RGB")
            top = [im.getpixel((x, 10)) for x in range(0, 960, 40)]
            page = im.getpixel((900, 600))
            if all(p == page for p in top):
                fails.append("the frame's top rows look like the page: the browser chrome was not captured")
        except Exception as e:  # noqa: BLE001
            fails.append(f"{type(e).__name__}: {str(e)[-300:]}")
        finally:
            run_ab(["--session", sess, "close"])
            down(disp, d / "profile")
    print("window.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    g = lambda k, dflt=None: a[a.index(k) + 1] if k in a else dflt  # noqa: E731
    if a[0] == "up":
        w, h = map(int, g("--size", "1920x1080").split("x"))
        print(json.dumps(up(g("--display", ":99"), w, h, int(g("--port", 9333)), Path(g("--profile")).resolve(),
                            g("--url", "about:blank"))))
        return 0
    if a[0] == "down":
        down(g("--display", ":99"), Path(g("--profile")).resolve())
        return 0
    if a[0] == "shot":
        disp = g("--display", ":99")
        geo = subprocess.run(["xdpyinfo"], capture_output=True, text=True, env={**os.environ, "DISPLAY": disp}).stdout
        dims = next((ln.split()[1] for ln in geo.splitlines() if "dimensions:" in ln), "1920x1080")
        w, h = map(int, dims.split("x"))
        print(grab(disp, Path(g("--out", "shot.png")), w, h))
        return 0
    print(f"window.py: unknown command {a[0]}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
