"""Text that reads on a video, and the pieces whose text morphs in place: Code and Eq."""

from __future__ import annotations

import re
from difflib import SequenceMatcher

from manim import (
    LEFT,
    UL,
    UP,
    Animation,
    ImageMobject,
    Rectangle,
    RoundedRectangle,
    Text,
    Transform,
    VGroup,
    interpolate_color,
    rate_functions,
)
from manim import ManimColor
from pygments import lex
from pygments.lexers import get_lexer_by_name
from pygments.token import Comment, Keyword, Name, Number, Operator, Punctuation, String

from . import theme as T


def mix(c0, c1, a: float):
    """The color `a` of the way from `c0` to `c1`."""
    return ManimColor(c0).interpolate(ManimColor(c1), a)


def mark_text(t: Text, kind: str, px: float) -> Text:
    """Record what kind of text `t` is and its em size, so the check can measure it after scaling."""
    t._cv_kind, t._cv_px = kind, px
    if t.submobjects:
        t._cv_ref = max(t.submobjects, key=lambda g: g.width)
        t._cv_w0 = t._cv_ref.width
    return t


def text(s: str, size: float = T.LABEL, color: str = T.TEXT, font: str = T.SANS, kind: str = "label") -> Text:
    """Words on stage: Inter at `size` em px (1080p). Use font=T.SERIF for the math voice."""
    t = Text(s, font=font, font_size=T.fs(size), color=color, disable_ligatures=True, line_spacing=0.9)
    return mark_text(t, kind, size)


def faded(mob, k: float = 0.4) -> Transform:
    """Animation: scale `mob`'s opacity by `k` (0.4 dims it to a ghost, 1/0.4 brings it back)."""
    target = mob.copy()
    for m in target.get_family():
        if isinstance(m, ImageMobject):
            m.set_opacity(min(1, m.fill_opacity * k))
        elif hasattr(m, "get_fill_opacity"):
            m.set_fill(opacity=min(1, m.get_fill_opacity() * k), family=False)
            m.set_stroke(opacity=min(1, m.get_stroke_opacity() * k), family=False)
    return Transform(mob, target)


def reveal(child, target=None) -> Transform:
    """Animation: bring a hidden part of a piece to its full look (pieces hide new parts first)."""
    return Transform(child, target if target is not None else child._cv_full)


def hidden(child):
    """Hide a new part of a piece until reveal(child) plays."""
    child._cv_full = child.copy()
    child.set_opacity(0)
    return child


class _Morph(Animation):
    """Turn one tokenized text piece into another in place: shared tokens glide to their new
    places, removed tokens fade (turning red first when `marks`), added ones arrive (green)."""

    def __init__(self, mob, target, marks: bool, run_time: float):
        super().__init__(mob, run_time=run_time, rate_func=rate_functions.linear)
        self.target, self.marks = target, marks

    def begin(self):
        old, new = self.mobject._tokens, self.target._tokens
        sm = SequenceMatcher(None, [t for t, _ in old], [t for t, _ in new], autojunk=False)
        self.pairs, self.gone, born = [], [], []
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for (_, ga), (_, gb) in zip(old[i1:i2], new[j1:j2]):
                    self.pairs += [(a, a.copy(), b) for a, b in zip(ga, gb)]
            else:
                self.gone += [(g, g.get_fill_color()) for _, gs in old[i1:i2] for g in gs]
                born += [g for _, gs in new[j1:j2] for g in gs]
        if self.marks:
            for g in born:
                g.set_color(T.GREEN)
        self.gone += [(g, g.get_fill_color()) for g in self.mobject._fading()]
        self.born = [g.copy() for g in [*born, *self.target._arriving(born)]]
        self.full = [(g.get_fill_opacity(), g.get_stroke_opacity()) for g in self.born]
        for g in self.born:
            g.set_opacity(0)
        self.mobject.add(*self.born)
        self.shapes = [(a, a.copy(), b) for a, b in self.mobject._shapes(self.target)]
        super().begin()

    def interpolate(self, alpha: float) -> None:
        a1 = min(1.0, alpha / 0.3)
        a2 = rate_functions.smooth(min(1.0, max(0.0, (alpha - 0.25) / 0.45)))
        a3 = rate_functions.smooth(min(1.0, max(0.0, (alpha - 0.65) / 0.35)))
        for g, g0, g1 in self.pairs:
            g.interpolate(g0, g1, a2)
        for g, color in self.gone:
            if self.marks:
                g.set_fill(mix(color, T.RED, a1))
            g.set_opacity(1 - a2)
        for g, (fill, stroke) in zip(self.born, self.full):
            g.set_fill(opacity=fill * a3, family=False).set_stroke(opacity=stroke * a3, family=False)
        for part, p0, p1 in self.shapes:
            part.interpolate(p0, p1, a2)

    def finish(self):
        super().finish()
        self.mobject.submobjects = list(self.target.submobjects)
        for key, value in vars(self.target).items():
            if key in self.mobject._state:
                setattr(self.mobject, key, value)


_LEXER_COLORS = [(Comment, "comment"), (Keyword, "keyword"), (Name.Function, "function"),
                 (Name.Other, "function"), (Number, "number"), (String, "string"),
                 (Operator, "punct"), (Punctuation, "punct"), (Name, "name")]


def _syntax(tok) -> str:
    return next((T.SYNTAX[key] for base, key in _LEXER_COLORS if tok in base), T.SYNTAX["name"])


class Code(VGroup):
    """Syntax-colored code on a panel. Lines are numbered from 1, like an editor."""

    STRUT = "\u2502"
    _state = ("src", "lines", "panel", "path_label", "bands", "_tokens", "_rows")

    def __init__(self, src: str, lang: str = "python", path: str | None = None, size: float = T.CODE):
        super().__init__()
        self.lang, self.path, self.size = lang, path, size
        self.src = src.expandtabs(4).rstrip("\n")
        rows = self.src.split("\n")
        em = size / 135
        self.pitch, self.char_w = 1.45 * em, 0.6 * em
        runs = self._runs(rows)
        self.lines, self._tokens = VGroup(), []
        for i, (row, row_runs) in enumerate(zip(rows, runs)):
            line = Text(self.STRUT + row, font=T.MONO, font_size=T.fs(size), color=T.SYNTAX["name"],
                        disable_ligatures=True)
            strut = line.submobjects[0]
            line.shift([-strut.get_center()[0], -i * self.pitch - strut.get_center()[1], 0])
            line.remove(strut)
            glyphs = line.submobjects  # one per character, spaces included (disable_ligatures)
            if len(glyphs) == len(row):
                for word, color, col in row_runs:
                    gs = glyphs[col: col + len(word)]
                    for g in gs:
                        g.set_color(color)
                    self._tokens.append((word, gs))
            elif glyphs:
                self._tokens.append((row.strip(), list(glyphs)))
            self._tokens.append(("\n", []))
            self.lines.add(mark_text(line, "code", size))
        self._rows = rows
        pad = 0.38
        width = max(len(r) for r in rows) * self.char_w + 2 * pad
        height = len(rows) * self.pitch + 1.4 * pad
        self.panel = RoundedRectangle(width=width, height=height, corner_radius=0.12, stroke_color=T.FAINT,
                                      stroke_width=1.5, fill_color=T.PANEL, fill_opacity=1)
        x0 = self.char_w / 2  # column 0 starts one strut cell in
        self.panel.move_to([x0 - pad + width / 2, -(len(rows) - 1) * self.pitch / 2, 0])
        self.bands = VGroup()
        self.add(self.panel, self.bands, self.lines)
        self.path_label = None
        if path:
            self.path_label = text(path, size=T.SMALL, color=T.DIM, font=T.MONO)
            self.path_label.next_to(self.panel, UP, buff=0.14, aligned_edge=LEFT)
            self.add(self.path_label)
        self.move_to([0, 0, 0])
        self._cv_name = f'Code "{path or rows[0].strip()[:28]}"'

    def _runs(self, rows: list[str]) -> list[list[tuple[str, str, int]]]:
        out: list[list[tuple[str, str, int]]] = [[] for _ in rows]
        line, col = 0, 0
        for tok, value in lex(self.src, get_lexer_by_name(self.lang)):
            for k, piece in enumerate(value.split("\n")):
                if k:
                    line, col = line + 1, 0
                if line >= len(rows):
                    break
                for m in re.finditer(r"\S+", piece):
                    out[line].append((m.group(), _syntax(tok), col + m.start()))
                col += len(piece)
        return out

    def line_y(self, i: int) -> float:
        """Vertical center of line `i` (from 1)."""
        return self.panel.get_top()[1] - 0.7 * 0.38 - (i - 0.5) * self.pitch

    def _band(self, first: int, last: int, color: str, opacity: float) -> VGroup:
        h = (last - first + 1) * self.pitch
        y = (self.line_y(first) + self.line_y(last)) / 2
        band = Rectangle(width=self.panel.width - 0.04, height=h, stroke_width=0, fill_color=color,
                         fill_opacity=opacity).move_to([self.panel.get_center()[0], y, 0])
        gutter = Rectangle(width=0.07, height=h, stroke_width=0, fill_color=color, fill_opacity=1)
        return VGroup(band, gutter.move_to([self.panel.get_left()[0] + 0.06, y, 0]))

    def highlight(self, first: int, last: int | None = None, color: str = T.YELLOW) -> Transform:
        """Animation: a band over lines `first`..`last` with a gutter mark in `color`."""
        band = hidden(self._band(first, last or first, color, 0.16))
        self.bands.add(band)
        return reveal(band)

    def change(self, new_src: str, run_time: float = 2.4) -> Animation:
        """Animation: edit the code in place. Removed text turns red and leaves, kept text glides
        to its new place, added text arrives in green with a green gutter mark on its line."""
        target = Code(new_src, self.lang, self.path, self.size)
        target.shift(self.panel.get_corner(UL) - target.panel.get_corner(UL))
        return _Morph(self, target, marks=True, run_time=run_time)

    def _fading(self):
        return [m for m in self.bands.get_family() if m.has_points()]

    def _arriving(self, born):
        born_ids = {id(g) for g in born}
        rows = sorted({i + 1 for i, line in enumerate(self.lines)
                       if any(id(g) in born_ids for g in line.submobjects)})
        for i in rows:
            self.bands.add(self._band(i, i, T.GREEN, 0.10))
        return [m for m in self.bands.get_family() if m.has_points()]

    def _shapes(self, target):
        return [(self.panel, target.panel)]


_EQ_TOKEN = re.compile(r"\$?\d[\d,]*(?:\.\d+)?|[A-Za-z_]\w*|\S")


class Eq(VGroup):
    """A line of math in the serif voice, e.g. Eq("$100.00 ÷ 3"); colors maps substrings to colors."""

    _state = ("expr", "body", "_tokens")

    def __init__(self, expr: str, size: float = T.NUMBER, colors: dict[str, str] | None = None,
                 color: str = T.TEXT):
        super().__init__()
        self.expr, self.size, self.color_ = expr, size, color
        self.body = text(expr, size=size, color=color, font=T.SERIF, kind="number")
        glyphs = self.body.submobjects  # one per character, spaces included (disable_ligatures)
        for sub, col in (colors or {}).items():
            for m in re.finditer(re.escape(sub), expr):
                for g in glyphs[m.start(): m.end()]:
                    g.set_color(col)
        self._tokens = [(m.group(), glyphs[m.start(): m.end()]) for m in _EQ_TOKEN.finditer(expr)]
        self.add(self.body)
        self._cv_name = f'Eq "{expr[:28]}"'

    def change(self, new_expr: str, colors: dict[str, str] | None = None, run_time: float = 1.6) -> Animation:
        """Animation: transform into `new_expr`; shared tokens glide, the rest fade out and in."""
        target = Eq(new_expr, self.size, colors, self.color_).move_to(self.get_center())
        return _Morph(self, target, marks=False, run_time=run_time)

    def _fading(self):
        return []

    def _arriving(self, born):
        return []

    def _shapes(self, target):
        return []


def edge_point(mob, toward):
    """Where the ray from `mob`'s center toward a point leaves its bounding box."""
    c = mob.get_center()
    d = toward - c
    hw, hh = mob.width / 2, mob.height / 2
    t = min(hw / abs(d[0]) if abs(d[0]) > 1e-6 else 1e9, hh / abs(d[1]) if abs(d[1]) > 1e-6 else 1e9)
    return c + d * min(t, 1.0)

