"""Video: a MovingCameraScene that runs on the narration clock.

A story subclasses Video and writes one method per beat, decorated with @beat. Each method
starts when its words start, and `self.at("words")` waits for a phrase. The clock counts frames
exactly, so a story renders in beat-sized chunks in parallel and the chunks join without drift.

The clock fits motion to the beat: an animation that would run past the beat's end is sped up
to fit, up to twice its speed, and one that would cross the beat's midpoint lands on it or starts
after it, so the midpoint frame the check reads is settled. Anything brought on stage is kept
inside the stage and above the caption band. At each beat's midpoint and end the clock records
every element's geometry for the check.

Each beat's render is cached under a key of everything its frames depend on (see state.py); a
beat whose key is cached is executed without drawing, and the caller reuses the cached frames.
"""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path

import numpy as np
from manim import (
    DOWN,
    DR,
    LEFT,
    RIGHT,
    UL,
    UP,
    AnimationGroup,
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

from . import report, state
from . import theme as T
from .text import em_px, fit, label_of

SQUEEZE = 0.5  # an animation may run at up to 1 / SQUEEZE times its speed to fit its beat
MIN_RUN = 0.3  # seconds; no animation is sped up below this
GHOST = 0.3  # elements fainter than this are background: others may sit on them
EDGE = 6.75  # the stage's left and right limits for anything brought on, in Manim units


def beat(say: str, show: str | None = None, pause: float | None = None, lead: float = 0.0,
         transition: bool = False):
    """Mark a Video method as one narration beat: `say` is spoken (audio tags like "[curious]" shape the voice and are never captioned), `show` captioned (digits allowed), `pause` the silence before it, `lead` starts its motion earlier, `transition=True` lets motion cross its midpoint."""

    def mark(fn):
        fn._cv_beat = {"name": fn.__name__, "say": " ".join(say.split()),
                       "show": " ".join((show or strip_tags(say)).split()), "pause": pause, "lead": lead,
                       "transition": transition}
        return fn

    return mark


_TAG = re.compile(r"\[[^\]]*\]")


def strip_tags(s: str) -> str:
    """`s` without its audio tags."""
    return " ".join(_TAG.sub(" ", s).split())


def beats_of(cls) -> list:
    fns = [fn for fn in vars(cls).values() if callable(fn) and hasattr(fn, "_cv_beat")]
    taken = [fn.__name__ for fn in fns if hasattr(Video, fn.__name__)]
    if taken:
        raise SystemExit(f"beat method(s) {', '.join(taken)} replace Video's own; rename them (e.g. {taken[0]}_beat)")
    return fns


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


def _leaves(anims):
    for a in anims:
        if isinstance(a, AnimationGroup):
            yield from _leaves(a.animations)
        else:
            yield a


def _box(m) -> tuple[float, float, float, float]:
    (x0, y1, _), (x1, y0, _) = m.get_corner(UL), m.get_corner(DR)
    return x0, y0, x1, y1


def _overlap(a, b) -> float:
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


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
        self.header = None
        self._out: list = []
        report._sinks.append(lambda message: self._note(message, problem=True))
        self._base_attrs = set(vars(self)) | {"_base_attrs"}

    def construct(self):
        timing = json.loads(Path(os.environ["CATCHUP_TIMING"]).read_text())
        fns = beats_of(type(self))
        names = [fn.__name__ for fn in fns]
        if names != [b["name"] for b in timing["beats"]]:
            raise SystemExit(f"timing.json is stale: story beats {names}, timing beats "
                             f"{[b['name'] for b in timing['beats']]}")
        lo, hi = (int(x) for x in os.environ.get("CATCHUP_BEATS", f"1-{len(fns)}").split("-"))
        cache = os.environ.get("CATCHUP_BEAT_CACHE")
        quality = f"{config.pixel_width}x{config.pixel_height}@{self._fps}"
        story_path = os.environ["CATCHUP_STORY"]
        tb = timing["beats"]
        slot = [max(0.0, b["start"] - fn._cv_beat["lead"]) for b, fn in zip(tb, fns)]
        slot.append(timing["total"])
        writer = self.renderer.file_writer
        for i, (fn, b) in enumerate(zip(fns, tb), 1):
            if i > hi:
                raise EndSceneEarlyException()
            t0 = 0.0 if i == 1 else slot[i - 1]
            f0 = round(t0 * self._fps)
            f1 = round(slot[i] * self._fps)
            local = self._local_timing(fn, b, t0, slot[i - 1], f1 - f0)
            start = self._frame  # later than f0 when the beat before ran over
            key = cached = None
            if i >= lo:
                attrs = sorted(set(vars(self)) - self._base_attrs) + ["_pins", "header"]
                key = state.beat_key(fn=fn, beat_fns=fns, story_path=story_path, quality=quality,
                                     timing={**local, "late": start - f0}, state=state.stage(self, attrs))
                cached = bool(cache) and (Path(cache) / key / "beat.json").is_file()
            draw = i >= lo and not cached
            self.renderer._original_skipping_status = not draw
            first = len(writer.partial_movie_files)
            self._b = {"index": i, "name": fn.__name__, "phrases": b["phrases"], "t0": t0, "f0": f0,
                       "start": start, "transition": fn._cv_beat["transition"], "rec": draw, "records": [],
                       "mid_f": f0 + round(local["mid"] * self._fps), "end_f": f1, "mid_done": False,
                       "cue": None, "since_cue": []}
            self._advance(f0 + round(local["begin"] * self._fps))
            fn(self)
            late = self._frame - self._b["end_f"]
            if late > 0:
                self._late(late)
            self._advance(self._b["end_f"])
            self._probe("end")
            if i >= lo:
                self._out.append({"index": i, "name": fn.__name__, "key": key, "cached": cached, "start": start,
                                  "frames": self._frame - start, "records": self._b["records"],
                                  "segments": [str(p) for p in writer.partial_movie_files[first:] if p]})

    def _local_timing(self, fn, b, t0: float, begin: float, frames: int) -> dict:
        """A beat's timing from the start of its frames: what its drawing depends on."""
        def rel(t: float) -> float:
            return round(t - t0, 3)

        return {"begin": rel(begin), "mid": rel((b["start"] + b["end"]) / 2), "frames": frames,
                "transition": fn._cv_beat["transition"],
                "phrases": [[p["text"], p["said"], rel(p["start"]), rel(p["end"])] for p in b["phrases"]]}

    def _f(self, t: float) -> int:
        """The frame of narration time `t`, counted from the current beat's first frame."""
        b = self._b
        return b["f0"] + round((t - b["t0"]) * self._fps)

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

    def _play(self, args, kwargs, after=None, place=True):
        anims = [prepare_animation(a) for a in args]
        b = self._b
        if anims and all(isinstance(a, Wait) for a in anims):
            run_time = kwargs.get("run_time", max(a.run_time for a in anims))
            n = max(1, round(run_time * self._fps))
            return self._wait(min(n, b["end_f"] - self._frame) if b else n)
        if place:
            self._keep_new_on_stage(anims)
        run_time = kwargs.get("run_time") or self.get_run_time(anims)
        want = self._frames(run_time)
        n = self._fit(b, want) if b else want
        if n != want:
            kwargs["run_time"] = (n - 0.5) / self._fps
        if b:
            b["since_cue"].append((anims, want / self._fps))
        super().play(*anims, **kwargs)
        _carry_text_marks(anims)
        self._tick(n)
        if after:
            after()
        if b and not b["mid_done"] and self._frame >= b["mid_f"]:
            self._probe("mid")

    def _fit(self, b, n: int) -> int:
        """The frames an animation of `n` frames gets, never fewer than SQUEEZE of them: moved off
        the beat's midpoint (landing on it, or starting after it) and sped up to end with the beat.
        When neither side of the midpoint has room even at that speed, it runs across it."""
        floor = max(math.ceil(n * SQUEEZE), min(n, round(MIN_RUN * self._fps)))
        mid, end = b["mid_f"], b["end_f"]
        if not b["mid_done"] and not b["transition"] and self._frame < mid < self._frame + n:
            before, after = mid - self._frame, end - mid
            if 2 * before >= n and before >= floor:
                return before  # mostly done by the midpoint: land on it
            if after >= n:
                self._wait(before)  # barely started: start right after it
                return n
            if max(before, after) >= floor:
                if before >= after:
                    return before
                self._wait(before)
                return after
        left = end - self._frame
        return n if n <= left else max(left, floor)

    def _late(self, late: int) -> None:
        b = self._b
        played = ", ".join(f"{_anim_label(a)} ({t:.1f}s)" for anims, t in b["since_cue"] for a in anims[:1])
        where = f'after "{b["cue"]}"' if b["cue"] else "in this beat"
        self._note(f"runs {late / self._fps:.2f}s past its slot even with its animations sped up to twice their "
                   f"speed; {where} it plays {played or 'nothing'}: cut one of them, or start it at an earlier "
                   "phrase (self.at) or before the words (lead=)", problem=True)

    def add_mobjects_from_animations(self, animations):
        # Manim adds an AnimationGroup's synthetic Group to the scene, which pulls its
        # mobjects out of their pieces; add only what each inner animation brings.
        super().add_mobjects_from_animations(list(_leaves(animations)))

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
        target = min(self._f(t + offset), b["end_f"])
        if self._frame - target > 0.25 * self._fps:
            self._note(f"cue {words!r} comes {(self._frame - target) / self._fps:.2f}s before the "
                       "previous animation ends, so its motion starts late")
        self._advance(target)
        b["cue"], b["since_cue"] = words, []

    def hold(self, seconds: float) -> None:
        """Wait `seconds` on the clock, at most until the beat ends."""
        self._wait(max(1, min(round(seconds * self._fps), self._b["end_f"] - self._frame)))

    # ---- records for the check -----------------------------------------------

    def _note(self, message: str, problem: bool = False) -> None:
        if self._b and self._b["rec"]:
            self._b["records"].append({"kind": "note", "problem": problem, "message": message})

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
            item = {"name": label_of(m), "box": [*px(m.get_corner(UL)), *px(m.get_corner(DR))],
                    "over": over_ix, "texts": [], "ghost": bool(_opacity(m) < GHOST)}
            if hasattr(m, "_cv_parts"):
                item["parts"] = [[part, [*px(p.get_corner(UL)), *px(p.get_corner(DR))]]
                                 for part, p in m._cv_parts() if _opacity(p) >= GHOST]
            if isinstance(m, Line):
                item["seg"] = [px(m.get_start()), px(m.get_end())]
            for t in m.get_family():
                if isinstance(t, Text) and t.submobjects and _opacity(t) > 0.05:
                    item["texts"].append([getattr(t, "_cv_kind", "label"), round(em_px(t) * zoom, 1),
                                          t.original_text.lstrip("\u2502")[:40],
                                          [*px(t.get_corner(UL)), *px(t.get_corner(DR))]])
            out.append(item)
        # A transition beat's motion runs through its midpoint, so its geometry there is not
        # recorded, but its frame is still taken at the midpoint itself.
        b["records"].append({"kind": at, "frame": (b["mid_f"] if at == "mid" else self._frame) - b["start"],
                             "skipped": at == "mid" and b["transition"], "elements": out})

    def _elements(self):
        """Each element on stage: a piece, a text, or a shape, with plain groups opened."""
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

    def _stage_top(self) -> float:
        return T.TOP if self.header is not None else T.CEIL

    def _keep_new_on_stage(self, anims) -> None:
        """Fit what these animations bring on stage inside it, moved as one, above the captions."""
        frame = self.camera.frame
        if abs(frame.width - config.frame_width) > 1e-3 or np.abs(frame.get_center()).max() > 1e-3:
            return  # the camera is flying; the dive and pull_back place their own pieces
        present = {id(m) for m in self.get_mobject_family_members()}
        new = []
        for a in _leaves(anims):
            m = a.mobject
            if m is not frame and id(m) not in present and m not in new:
                new.append(m)
        if not new:
            return
        group = new[0] if len(new) == 1 else Group(*new)
        top = self._stage_top()
        fit(group, 2 * EDGE, top - T.FLOOR)
        x0, y0, x1, y1 = _box(group)
        dx = -EDGE - x0 if x0 < -EDGE else (EDGE - x1 if x1 > EDGE else 0.0)
        dy = T.FLOOR - y0 if y0 < T.FLOOR else (top - y1 if y1 > top else 0.0)
        if dx or dy:
            group.shift([dx, dy, 0])

    def pin(self, *mobs):
        """Keep `mobs` on stage through clear()."""
        self._pins += mobs

    def show(self, *mobs, run_time: float = 0.8, lag: float = 0.15):
        """Fade `mobs` in, one after another, rising slightly; they are kept on stage."""
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

    def beside(self, mob, target, side=None, buff: float = 0.3):
        """Place `mob` next to `target` on the first side (right, below, left, above, or only
        `side`) where it stays on stage and clear of everything shown; returns `mob`."""
        mine = {id(f) for f in [*mob.get_family(), *target.get_family()]}
        boxes = [_box(p) for m in self._elements() if _opacity(m) >= GHOST
                 for p in _solid(m) if not mine & {id(f) for f in p.get_family()}]
        top = self._stage_top()
        best = None
        for d in [side] if side is not None else [RIGHT, DOWN, LEFT, UP]:
            mob.next_to(target, d, buff=buff)
            x0, y0, x1, y1 = box = _box(mob)
            out = max(0.0, -EDGE - x0) + max(0.0, x1 - EDGE) + max(0.0, T.FLOOR - y0) + max(0.0, y1 - top)
            score = (out > 0.01, sum(_overlap(box, o) for o in boxes), out)
            if score[:2] == (False, 0.0):
                return mob
            if best is None or score < best[0]:
                best = (score, d)
        mob.next_to(target, best[1], buff=buff)
        return mob

    def recap(self, graph, cues: dict[int, str], color: str = T.YELLOW):
        """Call out each PR of `graph` as the narration reaches its words: recap({51: "merge the cache"})."""
        for n, words in cues.items():
            self.at(words)
            self.play(graph.point(n, color))

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
        self._play([*anims, *(FadeOut(m) for m in gone)], {"run_time": run_time}, settle, place=False)

    def pull_back(self, graph, run_time: float = 1.5, zoom: float = 4.0):
        """Fade the chapter out while the camera flies back out to the whole graph; the header returns to its node."""
        if self.header is None:
            raise ValueError("dive(graph, n) before pulling back")
        gone = self._unpinned([graph])
        anims, settle = self._fly(graph, self.header._cv_pr, zoom, inward=False)
        self._play([*anims, *(FadeOut(m, rate_func=_early) for m in gone)], {"run_time": run_time}, settle,
                   place=False)

    def _fly(self, graph, n, zoom, inward):
        frame = self.camera.frame
        c0, w0 = frame.get_center().copy(), frame.width
        node = graph.node(n).get_center()
        start = graph.label(n).copy()
        head = graph.header_for(n)
        if inward:
            flier = start.copy()  # enters with the flight's first frame, not before the clock waits
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
                # The header itself replaces the flier, so its text keeps its own measured size.
                self.remove(flier)
                head._cv_pr, head._cv_name = n, f"header #{n}"
                self.add(head)
                self.header = head
                self.pin(head)
            else:
                graph.visibility(1.0)
                self.remove(flier)
                self.header = None

        flight = UpdateFromAlphaFunc(frame, move_frame)
        flight._cv_verb = "dive" if inward else "pull_back"
        return [flight, UpdateFromAlphaFunc(graph, fade_graph),
                UpdateFromAlphaFunc(flier, place, introducer=inward)], settle


def _anim_label(a) -> str:
    named = getattr(a, "_cv_verb", None)
    if named:
        return named
    inner = next(iter(_leaves([a])), a)
    return f"{type(inner).__name__} {label_of(inner.mobject)}"


def _carry_text_marks(anims) -> None:
    """After Transform(a, b), `a` shows b's words: give its texts b's names and em sizes too."""
    for a in _leaves(anims):
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


def _solid(m) -> list:
    """What of `m` others must keep clear of: the parts a piece names, or `m` whole."""
    if hasattr(m, "_cv_parts"):
        return [p for _, p in m._cv_parts() if _opacity(p) >= GHOST]
    return [m]


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
