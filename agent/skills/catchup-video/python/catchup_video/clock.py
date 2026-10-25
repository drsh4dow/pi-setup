"""Video: a MovingCameraScene that runs on the narration clock.

A story subclasses Video and writes one method per beat, decorated with @beat.
Each method starts when its words start. `self.at("words")` waits for a phrase.
The clock counts frames exactly, so a story can render in beat-sized chunks in
parallel and the chunks join without drift. An animation that would cross a
beat's midpoint is moved so it lands before or starts after it, and the clock
records every element's geometry at each beat's midpoint and end for the check.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import numpy as np
from manim import (
    AnimationGroup,
    DR,
    LEFT,
    UL,
    UP,
    FadeIn,
    FadeOut,
    Group,
    ImageMobject,
    LaggedStart,
    Line,
    MovingCameraScene,
    Text,
    Transform,
    UpdateFromAlphaFunc,
    VGroup,
    VMobject,
    Wait,
    config,
    interpolate,
    rate_functions,
)
from manim.animation.animation import prepare_animation
from manim.utils.exceptions import EndSceneEarlyException

from . import theme as T


def beat(say: str, show: str | None = None, pause: float | None = None, lead: float = 0.0,
         transition: bool = False):
    """Mark a Video method as one narration beat: `say` is spoken, `show` captioned (digits allowed).

    `pause` is the silence before the beat, `lead` starts its motion that many seconds
    before its words, and `transition=True` lets its motion run across the midpoint.
    """

    def mark(fn):
        fn._cv_beat = {"name": fn.__name__, "say": " ".join(say.split()),
                       "show": " ".join((show or say).split()), "pause": pause, "lead": lead,
                       "transition": transition}
        return fn

    return mark


def beats_of(cls) -> list:
    return [fn for fn in vars(cls).values() if callable(fn) and hasattr(fn, "_cv_beat")]


def over(mob, *targets):
    """Mark `mob` as meant to sit on `targets`, so the check does not report it overlapping them."""
    mob._cv_over = [*getattr(mob, "_cv_over", []), *targets]
    return mob


def name(mob, label: str):
    """Give `mob` the name the check reports it by."""
    mob._cv_name = label
    return mob


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9$.%]+", " ", s.lower()).strip()


class Video(MovingCameraScene):
    voice = "Iapetus"

    # ---- clock ---------------------------------------------------------------

    def setup(self):
        super().setup()
        self.camera.background_color = T.BG
        self._fps = config.frame_rate
        self._frame = 0
        self._b = None
        self._pins: list = []
        self._records: list = []
        self.header = None

    def construct(self):
        timing = json.loads(Path(os.environ["CATCHUP_TIMING"]).read_text())
        fns = beats_of(type(self))
        names = [fn.__name__ for fn in fns]
        if names != [b["name"] for b in timing["beats"]]:
            raise SystemExit(f"timing.json is stale: story beats {names}, timing beats "
                             f"{[b['name'] for b in timing['beats']]}")
        lo, hi = (int(x) for x in os.environ.get("CATCHUP_BEATS", f"1-{len(fns)}").split("-"))
        tb = timing["beats"]
        slot = [max(0.0, b["start"] - fn._cv_beat["lead"]) for b, fn in zip(tb, fns)]
        slot.append(timing["total"])
        try:
            for i, (fn, b) in enumerate(zip(fns, tb), 1):
                if i > hi:
                    raise EndSceneEarlyException()
                self.renderer._original_skipping_status = i < lo
                if i == lo:
                    self._records.append({"beat": i, "name": fn.__name__, "kind": "start", "frame": self._frame})
                self._b = {"index": i, "name": fn.__name__, "phrases": b["phrases"],
                           "transition": fn._cv_beat["transition"], "rec": i >= lo,
                           "mid_f": round((b["start"] + b["end"]) / 2 * self._fps),
                           "end_f": round(slot[i] * self._fps), "mid_done": False}
                self._advance(round(slot[i - 1] * self._fps))
                fn(self)
                late = self._frame - self._b["end_f"]
                if late > 0:
                    self._note(f"runs {late / self._fps:.2f}s past its slot, into the next beat; "
                               "shorten its animations or start them earlier", problem=True)
                self._advance(self._b["end_f"])
                self._probe("end")
        finally:
            out = os.environ.get("CATCHUP_PROBES")
            if out:
                Path(out).write_text(json.dumps({"fps": self._fps, "records": self._records}))

    def _frames(self, run_time: float) -> int:
        return len(np.arange(0, run_time, 1 / self._fps))

    def _advance(self, target: int) -> None:
        if target > self._frame:
            self._wait(target - self._frame)

    def _wait(self, n: int) -> None:
        b = self._b
        if b and not b["mid_done"] and self._frame < b["mid_f"] <= self._frame + n:
            first = b["mid_f"] - self._frame
            self._wait_raw(first)
            self._probe("mid")
            n -= first
        if n > 0:
            self._wait_raw(n)

    def _wait_raw(self, n: int) -> None:
        # Manim emits int(t * fps) frames for a frozen wait and ceil(t * fps) otherwise,
        # so half a frame either way makes both exact.
        frozen = not (self.always_update_mobjects or self.updaters
                      or any(m.has_time_based_updater() for m in self.get_mobject_family_members()))
        run_time = (n + 0.5) / self._fps if frozen else (n - 0.5) / self._fps
        super().play(Wait(run_time=run_time, frozen_frame=frozen))
        self._tick(n)

    def _tick(self, n: int) -> None:
        self._frame += n
        self.renderer.time = self._frame / self._fps

    def play(self, *args, **kwargs):
        self._play(args, kwargs)

    def _play(self, args, kwargs, after=None):
        anims = [prepare_animation(a) for a in args]
        if anims and all(isinstance(a, Wait) for a in anims):
            run_time = kwargs.get("run_time", max(a.run_time for a in anims))
            return self._wait(max(1, round(run_time * self._fps)))
        run_time = kwargs.get("run_time") or self.get_run_time(anims)
        n = self._frames(run_time)
        b = self._b
        if b and not b["mid_done"] and not b["transition"] and self._frame < b["mid_f"] < self._frame + n:
            before = b["mid_f"] - self._frame
            if 2 * before >= n:  # mostly done by the midpoint: land on it
                kwargs["run_time"] = (before - 0.5) / self._fps
                n = before
            else:  # barely started: start right after it
                self._wait(before)
        super().play(*anims, **kwargs)
        _carry_text_marks(anims)
        self._tick(n)
        if after:
            after()
        if b and not b["mid_done"] and self._frame >= b["mid_f"]:
            self._probe("mid")

    def add_mobjects_from_animations(self, animations):
        # Manim adds an AnimationGroup's synthetic Group to the scene, which pulls its
        # mobjects out of their pieces; add only what each inner animation brings.
        def flat(anims):
            for a in anims:
                if isinstance(a, AnimationGroup):
                    yield from flat(a.animations)
                else:
                    yield a

        super().add_mobjects_from_animations(list(flat(animations)))

    def at(self, words: str | int, offset: float = 0.0) -> None:
        """Wait until the narration reaches `words` (a phrase index, or words in the beat)."""
        b = self._b
        if isinstance(words, int):
            t = b["phrases"][words]["start"]
        else:
            want = _norm(words)
            for p in b["phrases"]:
                for said in (p["text"], p["said"]):
                    k = _norm(said).find(want)
                    if k >= 0:
                        t = interpolate(p["start"], p["end"], k / max(1, len(_norm(said))))
                        break
                else:
                    continue
                break
            else:
                raise ValueError(f"beat {b['name']}: no phrase contains {words!r}; phrases: "
                                 f"{[p['text'] for p in b['phrases']]}")
        target = round((t + offset) * self._fps)
        if self._frame - target > 0.25 * self._fps:
            self._note(f"cue {words!r} comes {(self._frame - target) / self._fps:.2f}s before the "
                       "previous animation ends, so its motion starts late")
        self._advance(target)

    def hold(self, seconds: float) -> None:
        """Wait `seconds` on the clock."""
        self._wait(max(1, round(seconds * self._fps)))

    # ---- records for the check -----------------------------------------------

    def _note(self, message: str, problem: bool = False) -> None:
        if self._b and self._b["rec"]:
            self._records.append({"beat": self._b["index"], "name": self._b["name"], "kind": "note",
                                  "problem": problem, "message": message})

    def _probe(self, at: str) -> None:
        b = self._b
        if at == "mid":
            b["mid_done"] = True
        if not b["rec"]:
            return
        frame = self.camera.frame
        cx, cy = frame.get_center()[:2]
        w, h = frame.width, frame.height
        zoom = config.frame_width / w

        def px(p):
            return [round((p[0] - cx) / w * 1920 + 960, 1), round((cy - p[1]) / h * 1080 + 540, 1)]

        elements = list(self._elements())
        out = []
        for m in elements:
            allowed = {id(f) for t in getattr(m, "_cv_over", []) for f in t.get_family()}
            over_ix = [j for j, o in enumerate(elements)
                       if o is not m and (allowed & {id(f) for f in o.get_family()}
                                          or id(m) in {id(f) for t in getattr(o, "_cv_over", [])
                                                       for f in t.get_family()})]
            item = {"name": _label(m), "box": [*px(m.get_corner(UL)), *px(m.get_corner(DR))],
                    "over": over_ix, "texts": []}
            if isinstance(m, Line):
                item["seg"] = [px(m.get_start()), px(m.get_end())]
            for t in m.get_family():
                if isinstance(t, Text) and t.submobjects and _opacity(t) > 0.05:
                    item["texts"].append([getattr(t, "_cv_kind", "label"), round(_em_px(t) * zoom, 1),
                                          t.original_text.lstrip("\u2502")[:40],
                                          [*px(t.get_corner(UL)), *px(t.get_corner(DR))]])
            out.append(item)
        # A transition beat's motion runs through its midpoint, so its geometry there is not
        # recorded, but its frame is still taken at the midpoint itself.
        self._records.append({"beat": b["index"], "name": b["name"], "kind": at,
                              "frame": b["mid_f"] if at == "mid" else self._frame,
                              "skipped": at == "mid" and b["transition"], "elements": out})

    def _elements(self):
        frame = self.camera.frame

        def walk(m):
            if m is frame or _opacity(m) <= 0.05:
                return
            if type(m) in (VGroup, Group):
                for s in m.submobjects:
                    yield from walk(s)
            elif m.has_points() or m.submobjects or isinstance(m, ImageMobject):
                yield m

        for m in self.mobjects:
            yield from walk(m)

    # ---- staging helpers -----------------------------------------------------

    def pin(self, *mobs):
        """Keep `mobs` on stage through clear()."""
        self._pins += mobs

    def show(self, *mobs, run_time: float = 0.8, lag: float = 0.15):
        """Fade `mobs` in, one after another, rising slightly."""
        self.play(LaggedStart(*(FadeIn(m, shift=0.15 * UP) for m in mobs), lag_ratio=lag),
                  run_time=run_time)

    def hide(self, *mobs, run_time: float = 0.6):
        """Fade `mobs` out."""
        self.play(*(FadeOut(m) for m in mobs), run_time=run_time)

    def clear(self, *keep, run_time: float = 0.6, extra=()):
        """Fade out everything except pinned mobjects and `keep`, playing `extra` alongside."""
        gone = self._unpinned(keep)
        if gone or extra:
            self.play(*(FadeOut(m) for m in gone), *extra, run_time=run_time)

    def _unpinned(self, keep=()) -> list:
        kept = {id(f) for m in [*self._pins, *keep, self.header] if m is not None for f in m.get_family()}
        return [m for m in self.mobjects
                if m is not self.camera.frame and not kept & {id(f) for f in m.get_family()}]

    # ---- the PR graph camera ---------------------------------------------------

    def dive(self, graph, n: int, run_time: float = 1.5, zoom: float = 4.0):
        """Fly the camera into PR `n`'s node; its title lifts out to become the header."""
        if self.header is not None:
            raise ValueError("pull_back(graph) before diving into another PR")
        gone = self._unpinned([graph])
        anims, settle = self._fly(graph, n, zoom, inward=True)
        self._play([*anims, *(FadeOut(m) for m in gone)], {"run_time": run_time}, settle)

    def pull_back(self, graph, run_time: float = 1.5, zoom: float = 4.0):
        """Fade the chapter out while the camera flies back out to the whole graph; the header returns to its node."""
        if self.header is None:
            raise ValueError("dive(graph, n) before pulling back")
        gone = self._unpinned([graph])
        anims, settle = self._fly(graph, self.header._cv_pr, zoom, inward=False)
        self._play([*anims, *(FadeOut(m, rate_func=_early) for m in gone)], {"run_time": run_time}, settle)

    def _fly(self, graph, n, zoom, inward):
        frame = self.camera.frame
        c0, w0 = frame.get_center().copy(), frame.width
        node = graph.node(n).get_center()
        start = graph.label(n).copy()
        head = graph.header_for(n)
        if inward:
            flier = start.copy()
            self.add(flier)
        else:
            flier = self.header
            self._pins.remove(flier)

        def step(a):
            return rate_functions.smooth(a if inward else 1 - a)

        def frame_at(t):
            return c0 + (node - c0) * t, w0 / zoom ** t

        def move_frame(m, a):
            center, w = frame_at(step(a))
            m.set(width=w).move_to(center)

        def fade_graph(m, a):
            graph.visibility(max(0.0, 1 - 1.7 * step(a)), hidden=n)

        def place(m, a):
            t = step(a)
            if t == 0:
                m.become(start)
                return
            center, w = frame_at(t)
            k = w / w0  # world units per screen unit
            m.become(head)
            m.scale(interpolate(start.height / head.height, 1, t) * k, about_point=head.get_left())
            m.move_to(center + (interpolate(start.get_left(), head.get_left(), t) - c0) * k,
                      aligned_edge=LEFT)

        def settle():
            frame.set(width=w0).move_to(c0)
            if inward:
                flier.become(head)
                flier._cv_pr, flier._cv_name = n, f"header #{n}"
                self.header = flier
                self.pin(flier)
            else:
                graph.visibility(1.0)
                self.remove(flier)
                self.header = None

        return [UpdateFromAlphaFunc(frame, move_frame), UpdateFromAlphaFunc(graph, fade_graph),
                UpdateFromAlphaFunc(flier, place)], settle


def _carry_text_marks(anims) -> None:
    """After Transform(a, b), `a` shows b's words: give its texts b's names and em sizes too."""
    for a in anims:
        if isinstance(a, AnimationGroup):
            _carry_text_marks(a.animations)
            continue
        target = getattr(a, "target_copy", None)
        if not isinstance(a, Transform) or target is None:
            continue
        if hasattr(target, "_cv_name"):
            a.mobject._cv_name = target._cv_name
        shown = [m for m in a.mobject.get_family() if isinstance(m, Text)]
        wanted = [m for m in target.get_family() if isinstance(m, Text)]
        for s, t in zip(shown, wanted):
            s.original_text = t.original_text
            for k in ("_cv_kind", "_cv_px", "_cv_w0"):
                if hasattr(t, k):
                    setattr(s, k, getattr(t, k))
            ref = getattr(t, "_cv_ref", None)
            if ref is not None and ref in t.submobjects and len(s.submobjects) == len(t.submobjects):
                s._cv_ref = s.submobjects[t.submobjects.index(ref)]


def _early(t: float) -> float:
    """Ease that finishes in the first 40% of the animation, so a chapter is gone before the graph returns."""
    return rate_functions.smooth(min(1.0, t / 0.4))


def _label(m) -> str:
    named = getattr(m, "_cv_name", None)
    if named:
        return named
    if isinstance(m, Text):
        return f'Text "{m.original_text[:32]}"'
    c = m.get_center()
    return f"{type(m).__name__} at ({c[0]:.1f}, {c[1]:.1f})"


def _opacity(m) -> float:
    best = 0.0
    for f in m.get_family():
        if isinstance(f, ImageMobject):
            best = max(best, f.fill_opacity)
        elif isinstance(f, VMobject) and f.has_points():
            stroke = f.get_stroke_opacity() if f.get_stroke_width() > 0 else 0.0
            best = max(best, f.get_fill_opacity(), stroke)
        if best > 0.05:
            break
    return best


def _em_px(t: Text) -> float:
    ref = getattr(t, "_cv_ref", None)
    if ref is not None and ref.width > 0:
        return t._cv_px * ref.width / t._cv_w0
    return t.font_size * T.PX
