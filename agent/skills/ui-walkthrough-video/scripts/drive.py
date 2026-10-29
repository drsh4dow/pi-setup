#!/usr/bin/env python3
"""Human-paced agent-browser driver for recording takes, with every action logged on the recording's clock.

As a module, from a take script of your own (stdlib only):

    sys.path.insert(0, "<skill dir>/scripts"); from drive import Take
    t = Take("t1-save", session="walk", out_dir="takes", width=1440, height=900, mask_js="<skill dir>/scripts/mask.js")
    t.state("start", note_length=812)            # the state this take starts from (provenance)
    t.start()                                    # viewport, mask, record start --cursor; the clock starts here
                                                 # (or `with t:` ... so a failing step still stops the recorder)
    t.mark_box("save", t.by_text("button", "Save"))   # a DOM box the edit can outline later
    t.click(t.by_text("button", "Save"), "Save")
    t.wait_until("document.body.innerText.includes('Saved')", "save lands")   # a wait the edit can jump-cut
    t.wrote("note", action_id="<receipt id>")    # a write this take made, with the receipt it owns
    t.stop()                                     # writes takes/t1-save.mp4 and takes/t1-save.events.json

CLI:
    drive.py preflight --session S --out DIR [--width 1440 --height 900]   # 2 s test take: is the window painting?
    drive.py --self-test

events.json: {"take", "width", "height", "fps", "recorded_at" (UTC), "events": [{"t", "kind", ...}],
"provenance": {"states", "writes"}}. t is seconds since `record start`. Logs hold coordinates, labels, lengths
and IDs, never typed text. Pointer moves are eased (--human) and take 280-900 ms; typing is per character,
35-90 ms apart; scrolls are real wheel events at the pointer (cdp.mjs wheel). One take records one tab: the
recorder follows the active tab, so a second tab is its own take.
"""
from __future__ import annotations

import datetime as dt
import json
import random
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run_ab(args: list[str], timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["agent-browser", *args], capture_output=True, text=True, timeout=timeout)


class Take:
    def __init__(self, name: str, session: str, out_dir, width: int = 1440, height: int = 900, fps: int = 30,
                 mask_js=None, mask_terms: list[str] | None = None, page_match: str = "", runner=run_ab):
        self.name, self.session, self.out = name, session, Path(out_dir)
        self.width, self.height, self.fps = width, height, fps
        self.mask_js, self.mask_terms, self.page_match = mask_js, mask_terms or [], page_match
        self.runner = runner
        self.events: list[dict] = []
        self.states: list[dict] = []
        self.writes: list[dict] = []
        self.t0: float | None = None
        self.recorded_at: str | None = None
        self.mouse = (width // 2, height // 2)
        self.rng = random.Random(name)

    # ---- plumbing -------------------------------------------------------
    def ab(self, *args: str, check: bool = True) -> str:
        r = self.runner(["--session", self.session, *args])
        if check and r.returncode != 0:
            raise RuntimeError(f"agent-browser {' '.join(args[:2])} failed: {r.stderr[-300:]}")
        return r.stdout.strip()

    def js(self, code: str):
        out = self.ab("eval", code)
        try:
            v = json.loads(out)
            return json.loads(v) if isinstance(v, str) and v[:1] in "{[" else v
        except json.JSONDecodeError:
            return out

    def now(self) -> float:
        return 0.0 if self.t0 is None else round(time.time() - self.t0, 3)

    def log(self, kind: str, **kw) -> dict:
        ev = {"t": self.now(), "kind": kind, **kw}
        self.events.append(ev)
        print(json.dumps(ev), file=sys.stderr, flush=True)
        return ev

    def save(self) -> Path:
        self.out.mkdir(parents=True, exist_ok=True)
        p = self.out / f"{self.name}.events.json"
        p.write_text(json.dumps({"take": self.name, "width": self.width, "height": self.height, "fps": self.fps,
                                 "recorded_at": self.recorded_at, "events": self.events,
                                 "provenance": {"states": self.states, "writes": self.writes}}, indent=1))
        return p

    # ---- provenance -------------------------------------------------------
    def state(self, label: str, **facts) -> None:
        """A fact about the product state (IDs, counts, lengths, times), before, during or after the take."""
        self.states.append(self.log("state", label=label, **facts))

    def wrote(self, what: str, **receipt) -> None:
        """A write this take made, with the receipt (action ID, row ID) it owns."""
        self.writes.append(self.log("write", what=what, **receipt))

    # ---- recording ------------------------------------------------------
    def start(self) -> None:
        self.ab("set", "viewport", str(self.width), str(self.height))
        if self.mask_terms:
            self.ab("eval", f"window.__uiwMaskTerms={json.dumps(self.mask_terms)}")
        if self.mask_js:
            self.ab("eval", Path(self.mask_js).read_text())
        time.sleep(0.3)
        self.out.mkdir(parents=True, exist_ok=True)
        self.ab("record", "start", str((self.out / f"{self.name}.mp4").resolve()), "--cursor", "--fps", str(self.fps))
        self.t0 = time.time()
        self.recorded_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        self.log("record_start")
        self.move(*self.mouse, dur=200)

    def stop(self) -> Path:
        self.log("record_stop")
        self.ab("record", "stop")
        return self.save()

    def __enter__(self) -> "Take":
        self.start()
        return self

    def __exit__(self, kind, err, tb) -> None:
        """Stop the recorder and keep the log even when a step fails, so a failed take never records on."""
        if kind:
            self.log("aborted", error=kind.__name__)
        self.stop()

    def pause(self, sec: float) -> None:
        time.sleep(sec)

    def mark(self, label: str, **kw) -> None:
        self.log("mark", label=label, **kw)

    def mark_box(self, label: str, js_expr: str, key: str = "box") -> dict:
        b = self.box(js_expr)
        self.mark(label, **{key: b})
        return b

    # ---- geometry -------------------------------------------------------
    def box(self, js_expr: str) -> dict:
        """js_expr evaluates to an Element; returns its viewport box in CSS px."""
        b = self.js(f"(()=>{{const e=({js_expr}); if(!e) return null; const r=e.getBoundingClientRect();"
                    f"return JSON.stringify({{x:r.x,y:r.y,w:r.width,h:r.height}})}})()")
        if not b:
            raise RuntimeError(f"no element for {js_expr[:80]}")
        return b

    @staticmethod
    def by_text(tag: str, text: str, exact: bool = True) -> str:
        t = json.dumps(text)
        cond = f"e.textContent.trim()==={t}" if exact else f"e.textContent.includes({t})"
        return f"[...document.querySelectorAll({json.dumps(tag)})].find(e=>{cond})"

    # ---- pointer ----------------------------------------------------------
    def move(self, x: float, y: float, dur: int | None = None) -> None:
        x, y = int(x), int(y)
        dist = ((x - self.mouse[0]) ** 2 + (y - self.mouse[1]) ** 2) ** 0.5
        dur = dur or int(min(900, max(280, dist * 0.9)))
        self.ab("mouse", "move", str(x), str(y), "--human", "--duration", str(dur), "--steps", str(max(8, dur // 16)),
                "--seed", str(self.rng.randint(1, 9999)))
        self.mouse = (x, y)

    def click_xy(self, x: float, y: float, label: str, hold: float = 0.08) -> None:
        self.move(x, y)
        time.sleep(0.12)
        self.log("click", x=int(x), y=int(y), label=label)
        self.ab("mouse", "down")
        time.sleep(hold)
        self.ab("mouse", "up")

    def click(self, js_expr: str, label: str, fx: float = 0.5, fy: float = 0.5) -> dict:
        b = self.box(js_expr)
        self.click_xy(b["x"] + b["w"] * fx, b["y"] + b["h"] * fy, label)
        return b

    def hover(self, js_expr: str, label: str) -> dict:
        b = self.box(js_expr)
        self.move(b["x"] + b["w"] / 2, b["y"] + b["h"] / 2)
        self.log("hover", label=label, **{k: int(v) for k, v in b.items()})
        return b

    def drag(self, x0, y0, x1, y1, label: str, dur: int = 700) -> None:
        self.move(x0, y0)
        time.sleep(0.15)
        self.log("drag", x=int(x0), y=int(y0), x1=int(x1), y1=int(y1), label=label)
        self.ab("mouse", "down")
        self.move(x1, y1, dur=dur)
        time.sleep(0.1)
        self.ab("mouse", "up")

    def wheel(self, dy: int, steps: int) -> None:
        ws = self.ab("get", "cdp-url")
        r = subprocess.run(["node", str(HERE / "cdp.mjs"), "wheel", "--ws", ws, "--match", self.page_match,
                            "--x", str(self.mouse[0]), "--y", str(self.mouse[1]), "--dy", str(dy), "--steps", str(steps)],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(r.stderr[-300:])

    def scroll(self, dy: int, label: str = "scroll") -> None:
        self.log("scroll", dy=dy, label=label)
        self.wheel(dy, max(12, abs(dy) // 20))
        time.sleep(0.3)

    def scroll_to(self, js_expr: str, target_y: float = 200, label: str = "scroll") -> None:
        b = self.box(js_expr)
        if abs(b["y"] - target_y) > 20:
            self.scroll(int(b["y"] - target_y), label=label)

    # ---- keyboard ---------------------------------------------------------
    def type(self, text: str, label: str) -> None:
        self.log("type_start", label=label, chars=len(text))
        for ch in text:
            self.ab("press", "Enter") if ch == "\n" else self.ab("keyboard", "type", ch)
            time.sleep(self.rng.uniform(0.035, 0.09))
        self.log("type_end", label=label)

    def press(self, key: str, label: str | None = None) -> None:
        self.log("key", key=key, label=label or key)
        self.ab("press", key)

    def paste(self, text: str, label: str) -> None:
        self.log("paste", label=label, chars=len(text))
        self.ab("keyboard", "inserttext", text)

    # ---- waits (logged so the edit can jump-cut them) ------------------------
    def wait_until(self, js_cond: str, label: str, timeout: float = 120, every: float = 1.0) -> float:
        self.log("wait_start", label=label)
        start = time.time()
        while time.time() - start < timeout:
            if self.js(f"(()=>{{try{{return !!({js_cond})}}catch(e){{return false}}}})()") is True:
                took = round(time.time() - start, 1)
                self.log("wait_end", label=label, took=took)
                return took
            time.sleep(every)
        self.log("wait_timeout", label=label)
        raise TimeoutError(label)


def preflight(session: str, out: Path, width: int, height: int) -> int:
    """Record 2 s while moving the pointer; fail when the window is not painting."""
    t = Take("preflight", session, out, width, height)
    try:
        t.start()
        t.move(width * 0.25, height * 0.3)
        t.move(width * 0.75, height * 0.7)
        t.stop()
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        print(f"preflight: FAIL, {type(e).__name__}: {str(e)[-200:]}\n  A pointer move that times out means the window"
              " is not painting (minimised or hidden). Open a new window with `cdp.mjs new-window`, attach there"
              " (agent-browser --session S connect <port>, then switch to its tab), and close only its tabs after.")
        return 1
    mp4 = out / "preflight.mp4"
    frames = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                             "stream=nb_read_frames", "-of", "csv=p=0", str(mp4)], capture_output=True, text=True).stdout.strip()
    frozen = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(mp4), "-vf", "freezedetect=n=-60dB:d=1.5",
                             "-f", "null", "-"], capture_output=True, text=True).stderr
    n = int(frames or 0)
    ok = n >= 15 and "freeze_start" not in frozen
    print(f"preflight: {'PASS' if ok else 'FAIL'}, {n} frames, pointer motion {'seen' if 'freeze_start' not in frozen else 'NOT seen'}"
          f" in {mp4}")
    return 0 if ok else 1


def self_test() -> int:
    import tempfile

    fails, calls = [], []

    class R:
        def __init__(self, out="", code=0):
            self.stdout, self.returncode, self.stderr = out, code, ""

    def fake(args):
        calls.append(args[2:])
        if args[2] == "eval" and "getBoundingClientRect" in args[3]:
            return R(json.dumps(json.dumps({"x": 100, "y": 40, "w": 80, "h": 20})))
        if args[2] == "eval" and "!!(" in args[3]:
            return R("true")
        return R()

    with tempfile.TemporaryDirectory() as tmp:
        t = Take("t1", "s", tmp, 800, 600, mask_js=HERE / "mask.js", mask_terms=["A Name"], runner=fake)
        t.wheel = lambda dy, steps: calls.append(["wheel", dy, steps])
        t.state("start", rows=3)
        t.start()
        t.mark_box("save", t.by_text("button", "Save"))
        t.click(t.by_text("button", "Save"), "Save")
        t.type("secret words", "note")
        t.scroll(400)
        t.wait_until("1", "lands")
        t.wrote("note", action_id="synthetic-1")
        p = t.stop()
        ev = json.loads(p.read_text())
        kinds = [e["kind"] for e in ev["events"]]
        want = ["state", "record_start", "mark", "click", "type_start", "type_end", "scroll", "wait_start", "wait_end",
                "write", "record_stop"]
        if kinds != want:
            fails.append(f"event kinds {kinds}")
        if "secret" in p.read_text():
            fails.append("typed text reached the events log")
        click = next(e for e in ev["events"] if e["kind"] == "click")
        if (click["x"], click["y"]) != (140, 50):
            fails.append(f"click at {click['x']},{click['y']}, want the box centre 140,50")
        if ev["provenance"]["writes"][0]["action_id"] != "synthetic-1" or ev["provenance"]["states"][0]["rows"] != 3:
            fails.append(f"provenance {ev['provenance']}")
        order = [c[0] for c in calls]
        i_vp, i_rec = order.index("set"), order.index("record")
        evals = [i for i, c in enumerate(calls) if c[0] == "eval" and "uiw" in " ".join(map(str, c))]
        if not (i_vp < min(evals) and max(evals) < i_rec):
            fails.append("viewport and mask must come before record start")
        rec = calls[i_rec]
        if rec[:2] != ["record", "start"] or "--cursor" not in rec or rec[rec.index("--fps") + 1] != "30":
            fails.append(f"record start args {rec}")
        times = [e["t"] for e in ev["events"]]
        if times != sorted(times):
            fails.append("event times go backwards")
        if ["wheel", 400, 20] not in calls:
            fails.append("scroll did not wheel at the pointer")
    print("drive.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    if a[0] == "preflight":
        g = lambda k, d=None: a[a.index(k) + 1] if k in a else d  # noqa: E731
        return preflight(g("--session"), Path(g("--out", ".")), int(g("--width", 1440)), int(g("--height", 900)))
    print(f"drive.py: unknown command {a[0]}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
