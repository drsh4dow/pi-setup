"""Pieces a story composes: tags, arrows, a layout grid, numbers, screenshots, tiles, bars, options."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from manim import (
    DOWN,
    LEFT,
    ORIGIN,
    RIGHT,
    UL,
    UP,
    AnimationGroup,
    Arc,
    Arrow,
    Circle,
    Group,
    ImageMobject,
    Line,
    Rectangle,
    RoundedRectangle,
    Transform,
    UpdateFromAlphaFunc,
    VGroup,
    VMobject,
    interpolate,
    interpolate_color,
    rate_functions,
)
from PIL import Image

from . import theme as T
from .text import edge_point, faded, fit, hidden, mark_text, mix, remakeable, reveal, text, verb


def icon(kind: str, color: str, size: float = 0.32) -> VMobject:
    """A small mark: "check", "cross", "dot", "ring", or "nobody" (no person in the loop)."""
    if kind == "nobody":
        head = Circle(radius=0.17, stroke_color=color, stroke_width=4).move_to([0, 0.2, 0])
        body = Arc(radius=0.3, start_angle=0, angle=np.pi, stroke_color=color, stroke_width=4).move_to([0, -0.2, 0])
        slash = Line([-0.42, -0.42, 0], [0.42, 0.42, 0], stroke_color=color, stroke_width=5)
        return VGroup(head, body, slash).scale(size / 0.5)
    if kind == "check":
        m = VMobject(stroke_color=color, stroke_width=5)
        m.set_points_as_corners([[-0.5, 0, 0], [-0.15, -0.38, 0], [0.55, 0.42, 0]])
    elif kind == "cross":
        m = VGroup(Line([-0.4, -0.4, 0], [0.4, 0.4, 0]), Line([-0.4, 0.4, 0], [0.4, -0.4, 0]))
        m.set_stroke(color, width=5)
    elif kind == "dot":
        m = Circle(radius=0.3, stroke_width=0, fill_color=color, fill_opacity=1)
    elif kind == "ring":
        m = Circle(radius=0.42, stroke_width=4, stroke_color=color)
    else:
        raise ValueError(f"icon kind must be check, cross, dot, ring, or nobody, not {kind!r}")
    return m.scale(size)


@remakeable
class Tag(VGroup):
    """A pill of words in the color of its meaning, with an optional icon in front; with `width`
    its words wrap and shrink to fit it; with `height` its pill trims its padding to stay that tall."""

    def __init__(self, words: str, color: str = T.DIM, icon_kind: str | None = None, size: float = T.SMALL,
                 width: float | None = None, height: float | None = None):
        room = None if width is None else width - 0.5 - (0.48 if icon_kind else 0.0)
        label = text(words, size=size, color=color, width=room)
        inner = VGroup(icon(icon_kind, color), label).arrange(RIGHT, buff=0.16) if icon_kind else VGroup(label)
        tall = inner.height + 0.3 if height is None else max(inner.height + 0.08, min(inner.height + 0.3, height))
        box = RoundedRectangle(width=inner.width + 0.5, height=tall, corner_radius=0.12,
                               stroke_color=color, stroke_width=2, fill_color=color, fill_opacity=0.10)
        super().__init__(box.move_to(inner), inner)
        self.words = words
        self._cv_name = f'Tag "{words}"'


def arrow(a, b, color: str = T.DIM, buff: float = 0.12) -> Arrow:
    """An arrow between two mobjects (or points), leaving and entering their bounding boxes."""
    pa = a if isinstance(a, np.ndarray) else None
    pb = b if isinstance(b, np.ndarray) else None
    ca = pa if pa is not None else a.get_center()
    cb = pb if pb is not None else b.get_center()
    start = pa if pa is not None else edge_point(a, cb)
    end = pb if pb is not None else edge_point(b, ca)
    return Arrow(start, end, buff=buff, stroke_width=4, color=color, tip_length=0.2,
                 max_tip_length_to_length_ratio=0.3, max_stroke_width_to_length_ratio=8)


class Grid:
    """Cells over the stage (between the header row and the caption band), counted from 0."""

    def __init__(self, cols: int, rows: int = 1, left: float = T.LEFT, right: float = T.RIGHT,
                 top: float = T.TOP, bottom: float = T.FLOOR, gap: float = 0.4):
        self.cols, self.rows, self.gap = cols, rows, gap
        self.left, self.top = left, top
        self.w = (right - left - gap * (cols - 1)) / cols
        self.h = (top - bottom - gap * (rows - 1)) / rows

    def size(self, cs: int = 1, rs: int = 1) -> tuple[float, float]:
        """Width and height of a block `cs` cells wide and `rs` high."""
        return cs * self.w + (cs - 1) * self.gap, rs * self.h + (rs - 1) * self.gap

    def cell(self, c: int, r: int = 0, cs: int = 1, rs: int = 1) -> np.ndarray:
        """Center of the block whose top-left cell is (c, r)."""
        w, h = self.size(cs, rs)
        return np.array([self.left + c * (self.w + self.gap) + w / 2, self.top - r * (self.h + self.gap) - h / 2, 0])

    def put(self, mob, c: int, r: int = 0, cs: int = 1, rs: int = 1, align=ORIGIN):
        """Fit `mob` into a block (shrinking it, never its text below the minimum) and move it there;
        `align` (e.g. LEFT, UP) pins it to that edge of the block. Blocks never overlap."""
        w, h = self.size(cs, rs)
        fit(mob, w, h)
        mob.move_to(self.cell(c, r, cs, rs) + np.array([align[0] * w / 2, align[1] * h / 2, 0]), aligned_edge=align)
        return mob


class Number(VGroup):
    """A number that ticks to new values and recolors, in the serif voice, with an optional
    `label` under it: Number(4, "{:,.0f} min", label="gifts table locked")."""

    def __init__(self, value: float, fmt: str = "{:,.0f}", size: float = T.NUMBER, color: str = T.TEXT,
                 align=ORIGIN, label: str | None = None):
        self.value, self.fmt, self.size, self.color_, self.align = value, fmt, size, color, align
        self._cache: dict = {}
        self.body = self._render(value, color)
        super().__init__(self.body)
        if label:
            self.caption = text(label, size=T.SMALL, color=T.DIM, width=max(4.0, self.body.width), align=ORIGIN)
            self.add(self.caption.next_to(self.body, DOWN, buff=0.3))
        self._cv_name = f"Number {fmt.format(value)}"

    def _render(self, value: float, color) -> VMobject:
        key = (self.fmt.format(value), str(color))
        if key not in self._cache:
            self._cache[key] = text(key[0], size=self.size, color=color, font=T.SERIF, kind="number")
        return self._cache[key].copy()

    @verb
    def tick(self, to: float, color: str | None = None, run_time: float = 1.2) -> UpdateFromAlphaFunc:
        """Animation: count to `to`, fading to `color` on the way."""
        v0, c0, c1 = self.value, self.color_, color or self.color_
        anchor = self.body.get_critical_point(self.align)

        def update(m, a):
            new = self._render(interpolate(v0, to, rate_functions.smooth(a)), mix(c0, c1, a))
            new.move_to(anchor, aligned_edge=self.align)
            m.body.become(new)
            mark_text(m.body, "number", self.size)
            m.body._cv_w0 = max(g.width for g in new.submobjects) if new.submobjects else 1
            m.body.original_text = new.original_text
            m._cv_name = f"Number {new.original_text}"

        self.value, self.color_ = to, c1
        return UpdateFromAlphaFunc(self, update, run_time=run_time)


class Shot(Group):
    """A real screenshot, cropped to (x0, y0, x1, y1) source pixels, on a thin frame."""

    def __init__(self, path: str, crop: tuple[int, int, int, int] | None = None, width: float = 6.0):
        src = Path(path)
        if not src.is_absolute():
            src = Path(os.environ.get("CATCHUP_STORY_DIR", ".")) / src
        img = Image.open(src).convert("RGB")
        self.crop = crop or (0, 0, *img.size)
        img = img.crop(self.crop)
        self.image = ImageMobject(np.array(img)).set(width=width)
        self.scale_px = width / img.size[0]
        self.frame = RoundedRectangle(width=self.image.width + 0.08, height=self.image.height + 0.08,
                                      corner_radius=0.06, stroke_color=T.FAINT, stroke_width=2)
        super().__init__(self.image, self.frame)
        self._cv_name = f"Shot {src.name}"

    def px(self, x: float, y: float) -> np.ndarray:
        """The stage point of source pixel (x, y)."""
        k = self.image.width / (self.crop[2] - self.crop[0])
        return self.image.get_corner(UL) + np.array([(x - self.crop[0]) * k, -(y - self.crop[1]) * k, 0])

    @verb
    def box(self, x0: float, y0: float, x1: float, y1: float, color: str = T.YELLOW):
        """Animation: outline source pixels (x0, y0)-(x1, y1) of the screenshot in `color`."""
        a, b = self.px(x0, y0), self.px(x1, y1)
        r = RoundedRectangle(width=abs(b[0] - a[0]) + 0.12, height=abs(b[1] - a[1]) + 0.12, corner_radius=0.05,
                             stroke_color=color, stroke_width=5).move_to((a + b) / 2)
        self.add(hidden(r))
        return reveal(r)


class Tiles(VGroup):
    """`n` small squares in rows of `cols`: items on a page, rows in a table."""

    def __init__(self, n: int, cols: int = 10, size: float = 0.3, gap: float = 0.08, color: str = T.BLUE):
        self.cols, self.step, self.color_ = cols, size + gap, color
        super().__init__(*(self._tile(size, color) for _ in range(n)))
        self._layout(self, cols)
        self.move_to(ORIGIN)
        self._cv_name = f"Tiles {n}"

    @staticmethod
    def _tile(size, color):
        return RoundedRectangle(width=size, height=size, corner_radius=0.04, stroke_width=0, fill_color=color,
                                fill_opacity=0.8)

    def _layout(self, tiles, cols):
        origin = self[0].get_center()
        for k, t in enumerate(tiles):
            t.move_to(origin + np.array([(k % cols) * self.step, -(k // cols) * self.step, 0]))

    @verb
    def tint(self, indices, color: str, run_time: float = 0.8) -> UpdateFromAlphaFunc:
        """Animation: recolor the tiles at `indices`."""
        picked = [(self[i], self[i].get_fill_color()) for i in indices]

        def update(m, a):
            for t, c0 in picked:
                t.set_fill(mix(c0, color, a))

        return UpdateFromAlphaFunc(self, update, run_time=run_time)

    @verb
    def reflow(self, n: int, cols: int, run_time: float = 1.4) -> UpdateFromAlphaFunc:
        """Animation: grow (or shrink) to `n` tiles in rows of `cols`, keeping the top-left corner."""
        origin = self[0].get_center()
        size = self[0].width
        while len(self) < n:
            self.add(hidden(self._tile(size, self.color_)))
        gone = list(self[n:])
        starts = [t.get_center().copy() for t in self]
        ends = [origin + np.array([(k % cols) * self.step, -(k // cols) * self.step, 0]) for k in range(len(self))]
        for k, t in enumerate(self):
            if hasattr(t, "_cv_full"):
                t.move_to(ends[k])
                starts[k] = ends[k]
        self.cols = cols

        def update(m, a):
            s = rate_functions.smooth(a)
            for k, t in enumerate(m):
                t.move_to(interpolate(starts[k], ends[k], s))
                if hasattr(t, "_cv_full"):
                    t.set_fill(opacity=0.8 * rate_functions.smooth(max(0, (a - 0.4) / 0.6)))
                if t in gone:
                    t.set_fill(opacity=0.8 * (1 - s))

        return UpdateFromAlphaFunc(self, update, run_time=run_time)


@remakeable
class Bars(VGroup):
    """Horizontal bars that compare values: Bars([("before", 840, T.RED), ("after", 35, T.GREEN)], "{:,.0f} ms").

    Rows start hidden; grow(i) reveals row i, its bar growing while its number counts up."""

    def __init__(self, rows: list[tuple[str, float, str]], fmt: str = "{:,.0f}", width: float = 7.0,
                 height: float = 0.55):
        self.rows = []
        peak = max(v for _, v, _ in rows)
        labels = [text(lab, color=T.DIM) for lab, _, _ in rows]
        lw = max(lab.width for lab in labels)
        parts = []
        for k, ((_, value, color), lab) in enumerate(zip(rows, labels)):
            y = -k * (height + 0.55)
            lab.move_to([lw, y, 0], aligned_edge=RIGHT)
            full = max(0.06, width * value / peak)
            bar = Rectangle(width=full, height=height, stroke_width=0, fill_color=color, fill_opacity=0.9)
            bar.move_to([lw + 0.35, y, 0], aligned_edge=LEFT)
            num = Number(value, fmt, size=T.LABEL + 4, color=color, align=LEFT)
            num.next_to(bar, RIGHT, buff=0.3)
            row = VGroup(lab, bar, num)
            self.rows.append((row, value, full))
            parts.append(hidden(row))
        super().__init__(*parts)
        self.move_to(ORIGIN)
        self.labels = [lab for lab, _, _ in rows]
        self._cv_name = "Bars"

    def _cv_parts(self):
        """What must never overlap, for the check: each row's label, bar, and number."""
        return [(f'{what} "{name}"', m) for name, (row, _, _) in zip(self.labels, self.rows)
                for what, m in zip(("label", "bar", "number"), row)]

    @verb
    def grow(self, *indices: int, run_time: float = 1.4):
        """Animation: reveal rows `indices` (all when empty), bars growing and numbers counting."""
        picked = [self.rows[i] for i in (indices or range(len(self.rows)))]
        plan = []
        for row, value, full in picked:
            lab, bar, num = row
            left = bar.get_left()
            plan.append((row, lab, bar, num, value, full, left, num.body.get_left()))
            row.set_opacity(1)
            bar.set_fill(opacity=0.9)
            del row._cv_full

        def update(m, a):
            s = rate_functions.smooth(a)
            for row, lab, bar, num, value, full, left, nleft in plan:
                lab.set_opacity(min(1, 3 * a))
                bar.stretch_to_fit_width(max(0.02, full * s)).move_to(left, aligned_edge=LEFT)
                new = num._render(value * s, num.color_)
                num.body.become(new.move_to(bar.get_right() + RIGHT * 0.3, aligned_edge=LEFT))
                num.value = value

        return UpdateFromAlphaFunc(self, update, run_time=run_time, introducer=True)


@remakeable
class Options(VGroup):
    """Side-by-side options, each a title over a body (lines of text or a mobject); pick(i) recommends one."""

    def __init__(self, items: list[tuple[str, object]], width: float = 12.6, gap: float = 0.5):
        cols = []
        w = (width - gap * (len(items) - 1)) / len(items)
        room = w - 0.9
        for title, body in items:
            head = text(title, size=T.LABEL + 4, width=room)
            if isinstance(body, str):
                body = [body]
            if isinstance(body, list):
                body = VGroup(*(text(line, size=T.SMALL, color=T.DIM, width=room) for line in body)).arrange(
                    DOWN, aligned_edge=LEFT, buff=0.22)
            else:
                fit(body, room, 3.0)
            inner = VGroup(head, body).arrange(DOWN, aligned_edge=LEFT, buff=0.45)
            cols.append(inner)
        h = max(c.height for c in cols) + 0.9
        self.panels = []
        groups = []
        for c in cols:
            panel = RoundedRectangle(width=w, height=h, corner_radius=0.14, stroke_color=T.FAINT, stroke_width=2,
                                     fill_color=T.PANEL, fill_opacity=1)
            c.move_to(panel).align_to(panel, UP + LEFT).shift(np.array([0.45, -0.45, 0]))
            self.panels.append(panel)
            groups.append(VGroup(panel, c))
        super().__init__(*groups)
        self.arrange(RIGHT, buff=gap, aligned_edge=UP)
        self.titles = [title for title, _ in items]
        self._cv_name = "Options"

    def _cv_parts(self):
        """What must never overlap, for the check: each card and each pick's note."""
        cards = [(f'card "{t}"', g) for t, g in zip(self.titles, self.submobjects)]
        return cards + [(f'pick "{n.words}"', n) for n in self.submobjects[len(self.titles):]]

    @verb
    def pick(self, i: int, note: str = "my pick", run_time: float = 1.0):
        """Animation: outline option `i` in yellow with `note` under it, and dim the others."""
        target = self.panels[i].copy().set_stroke(T.YELLOW, width=4)
        tag = Tag(note, T.YELLOW, "dot").next_to(self.panels[i], DOWN, buff=0.25)
        self.add(hidden(tag))
        return AnimationGroup(Transform(self.panels[i], target), reveal(tag),
                              *(faded(g, 0.45) for k, g in enumerate(self.submobjects[: len(self.panels)]) if k != i),
                              run_time=run_time)
