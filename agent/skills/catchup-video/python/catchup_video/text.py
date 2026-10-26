"""Text that reads on a video, and the pieces whose text morphs in place: Code and Eq."""

from __future__ import annotations

import functools
import inspect
import re
from difflib import SequenceMatcher
from functools import lru_cache

from manim import (
    DOWN,
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
    VMobject,
    interpolate_color,
    rate_functions,
)
from manim import ManimColor
from pygments import lex
from pygments.lexers import get_lexer_by_name
from pygments.token import Comment, Keyword, Name, Number, Operator, Punctuation, String

from . import theme as T
from .report import problem


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


def em_px(t: Text) -> float:
    """The em size of `t` in pixels at 1080p, as it stands after any scaling."""
    ref = getattr(t, "_cv_ref", None)
    if ref is not None and ref.width > 0 and getattr(t, "_cv_w0", 0) > 0:
        return t._cv_px * ref.width / t._cv_w0
    return t.font_size * T.PX


def label_of(m) -> str:
    """The name the check reports `m` by."""
    named = getattr(m, "_cv_name", None)
    if named:
        return named
    if isinstance(m, Text):
        return f'Text "{m.original_text[:32]}"'
    c = m.get_center()
    return f"{type(m).__name__} at ({c[0]:.1f}, {c[1]:.1f})"


def readable_scale(mob) -> float:
    """The smallest factor `mob` may be scaled by with every text in it at or above its minimum."""
    floor = 0.0
    for t in mob.get_family():
        if isinstance(t, Text) and t.submobjects:
            floor = max(floor, T.MIN_PX.get(getattr(t, "_cv_kind", "label"), T.MIN_PX["label"]) / em_px(t))
    return floor


def verb(fn):
    """Name the animation a piece's method returns ("Options.pick"), so the clock can say what to cut."""
    @functools.wraps(fn)
    def named(self, *args, **kw):
        anim = fn(self, *args, **kw)
        anim._cv_verb = f"{type(self).__name__}.{fn.__name__}"
        return anim

    return named


def remakeable(cls):
    """Class decorator: fit() rebuilds an instance at the width (and height) it must fit, so its
    words wrap and its parts reflow instead of shrinking."""
    init = cls.__init__
    params = inspect.signature(init).parameters

    @functools.wraps(init)
    def __init__(self, *args, **kw):
        init(self, *args, **kw)
        if type(self) is cls:
            def remake(w, h):
                extra = {"width": w, **({"height": h} if h is not None and "height" in params else {})}
                return cls(*args, **{**kw, **extra})

            self._cv_remake = remake

    cls.__init__ = __init__
    return cls


def _remade(mob, width, height) -> None:
    """Rebuild `mob` in place at `width` x `height`, keeping its center and its identity."""
    center = mob.get_center()
    fresh = mob._cv_remake(width if width is not None else mob.width, height)
    mob.__class__ = fresh.__class__
    mob.__dict__.clear()
    mob.__dict__.update(fresh.__dict__)
    mob.move_to(center)


def fit(mob, width: float | None = None, height: float | None = None):
    """Fit `mob` into `width` x `height` (Manim units): a piece rebuilds itself at that size, and
    anything else scales down, never its text below the minimum.

    When even the minimum does not fit, `mob` stays at the minimum and the beat reports it."""
    over = (width is not None and mob.width > width + 1e-6) or (height is not None and mob.height > height + 1e-6)
    if over and hasattr(mob, "_cv_remake"):
        _remade(mob, width, height)
    k = 1.0
    if width is not None and mob.width > width:
        k = width / mob.width
    if height is not None and mob.height > height:
        k = min(k, height / mob.height)
    if k >= 1.0:
        return mob
    floor = min(1.0, readable_scale(mob))
    if k < floor - 1e-6:
        need = f"{mob.width * floor * T.UNIT_PX:.0f} x {mob.height * floor * T.UNIT_PX:.0f} px"
        room = f"{(width or mob.width) * T.UNIT_PX:.0f} x {(height or mob.height) * T.UNIT_PX:.0f} px"
        problem(f"{label_of(mob)} needs {need} with its text at the minimum size, and its room is {room}: "
                "cut its words or give it more room")
        k = floor
    return mob.scale(k, about_point=mob.get_center())


def _line(s: str, size: float, color, font: str, kind: str) -> Text:
    t = Text(s, font=font, font_size=T.fs(size), color=color, disable_ligatures=True)
    return mark_text(t, kind, size)


@lru_cache(maxsize=4096)
def _width(s: str, size: float, font: str) -> float:
    return Text(s, font=font, font_size=T.fs(size), disable_ligatures=True).width


def _greedy(words: list[str], size: float, font: str, width: float) -> list[str]:
    rows: list[str] = []
    for w in words:
        if rows and _width(f"{rows[-1]} {w}", size, font) <= width:
            rows[-1] = f"{rows[-1]} {w}"
        else:
            rows.append(w)
    return rows


def _wrap(words: list[str], size: float, font: str, width: float) -> list[str]:
    """Words broken into lines no wider than `width` where a word allows it, as even as the same
    number of lines allows, so no line is left with one short word."""
    rows = _greedy(words, size, font, width)
    if len(rows) < 2:
        return rows
    lo, hi = max(_width(w, size, font) for w in words), width
    for _ in range(8):
        mid = (lo + hi) / 2
        if len(_greedy(words, size, font, mid)) <= len(rows):
            hi = mid
        else:
            lo = mid
    return _greedy(words, size, font, hi)


_FLAT = set("abcdefhiklmnorstuvwxzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")


def baseline(t) -> float:
    """The y of `t`'s baseline: the bottom of its letters that do not descend below it."""
    texts = [m for m in t.get_family() if isinstance(m, Text)]
    for m in texts[:1]:
        chars = m.original_text if len(m.original_text) == len(m.submobjects) else m.original_text.replace(" ", "")
        glyphs = [g for ch, g in zip(chars, m.submobjects) if ch in _FLAT]
        if glyphs:
            return max(g.get_bottom()[1] for g in glyphs)
    return t.get_bottom()[1]


def text(s: str, size: float = T.LABEL, color: str = T.TEXT, font: str = T.SANS, kind: str = "label",
         width: float | None = None, lines: int = 2, align=LEFT):
    """Words on stage at `size` em px (1080p). Given `width` (Manim units), they wrap onto up to
    `lines` lines and then shrink to fit it, never below the minimum. Use font=T.SERIF for math."""
    made = _text(s, size, color, font, kind, width, lines, align)
    made._cv_remake = lambda w, h: _text(s, size, color, font, kind, w, lines, align)
    return made


def _text(s, size, color, font, kind, width, lines, align):
    if width is None or _width(s, size, font) <= width:
        return _line(s, size, color, font, kind)
    words = s.split()
    floor = T.MIN_PX.get(kind, T.MIN_PX["label"])
    px = size
    rows = _wrap(words, px, font, width)
    while px > floor and (len(rows) > lines or any(_width(r, px, font) > width for r in rows)):
        px = max(floor, px * 0.95)
        rows = _wrap(words, px, font, width)
    widest = max(_width(r, px, font) for r in rows)
    if len(rows) > lines or widest > width + 1e-6:
        keep = max(1, int(len(s) * min(lines / len(rows), width / widest)))
        problem(f'text "{s[:40]}" does not fit {width * T.UNIT_PX:.0f} px in {lines} line(s) at the '
                f"{floor:.0f} px minimum: cut it to about {keep} characters or give it more room")
    if len(rows) == 1:
        return _line(rows[0], px, color, font, kind)
    block = VGroup(*(_line(r, px, color, font, kind) for r in rows)).arrange(DOWN, buff=0.28 * px / T.UNIT_PX,
                                                                           aligned_edge=align)
    block._cv_name = f'Text "{s[:32]}"'
    return block


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


def remember(mob) -> None:
    """Record the look `mob` has now, so look(mob, k) can set any part of it."""
    for m in mob.get_family():
        if isinstance(m, VMobject):
            m._cv_base = (m.get_fill_opacity(), m.get_stroke_opacity())
        elif isinstance(m, ImageMobject):
            m._cv_base = (m.fill_opacity, 0.0)


def look(mob, k: float) -> None:
    """Set `mob` to `k` of the look remember(mob) recorded."""
    for m in mob.get_family():
        base = getattr(m, "_cv_base", None)
        if base is None:
            continue
        if isinstance(m, ImageMobject):
            m.set_opacity(base[0] * k)
        else:
            m.set_fill(opacity=base[0] * k, family=False).set_stroke(opacity=base[1] * k, family=False)


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


@remakeable
class Code(VGroup):
    """Syntax-colored code on a panel. Lines are numbered from 1, like an editor."""

    STRUT = "\u2502"
    _state = ("src", "lines", "panel", "path_label", "bands", "_tokens", "_rows", "size", "pitch", "char_w")
    PAD = 0.38

    def __init__(self, src: str, lang: str = "python", path: str | None = None, size: float = T.CODE,
                 width: float = T.RIGHT - T.LEFT, height: float = T.TOP - T.FLOOR):
        """Code that fits `width` x `height` (default: the stage), shrinking to the minimum code size."""
        super().__init__()
        self.src = src.expandtabs(4).rstrip("\n")
        rows = self.src.split("\n")
        size = self._fitting_size(rows, size, width, height - (0.45 if path else 0.0), path)
        self.lang, self.path, self.size, self.max_w, self.max_h = lang, path, size, width, height
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
        pad = self.PAD
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
            self.path_label = text(path, size=T.SMALL, color=T.DIM, font=T.MONO, width=max(width, 3.0), lines=1)
            self.path_label.next_to(self.panel, UP, buff=0.14, aligned_edge=LEFT)
            self.add(self.path_label)
        self.move_to([0, 0, 0])
        self._cv_name = f'Code "{path or rows[0].strip()[:28]}"'

    @classmethod
    def _fitting_size(cls, rows: list[str], size: float, width: float, height: float, path) -> float:
        cols = max(len(r) for r in rows) or 1
        by_width = (width - 2 * cls.PAD) / (cols * 0.6) * 135
        by_height = (height - 1.4 * cls.PAD) / (len(rows) * 1.45) * 135
        fitted = min(size, by_width, by_height)
        floor = T.MIN_PX["code"]
        if fitted < floor:
            what = f'Code "{path or rows[0].strip()[:28]}"'
            if by_width < floor:
                most = int((width - 2 * cls.PAD) / (0.6 * floor / 135))
                problem(f"{what} has lines of {cols} characters; at the {floor:.0f} px minimum its room fits "
                        f"{most}: break or cut its long lines")
            else:
                most = int((height - 1.4 * cls.PAD) / (1.45 * floor / 135))
                problem(f"{what} has {len(rows)} lines; at the {floor:.0f} px minimum its room fits {most}: "
                        "show fewer lines")
            fitted = floor
        return fitted

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
        return self.panel.get_top()[1] - 0.7 * self.PAD - (i - 0.5) * self.pitch

    def _band(self, first: int, last: int, color: str, opacity: float) -> VGroup:
        h = (last - first + 1) * self.pitch
        y = (self.line_y(first) + self.line_y(last)) / 2
        band = Rectangle(width=self.panel.width - 0.04, height=h, stroke_width=0, fill_color=color,
                         fill_opacity=opacity).move_to([self.panel.get_center()[0], y, 0])
        gutter = Rectangle(width=0.07, height=h, stroke_width=0, fill_color=color, fill_opacity=1)
        return VGroup(band, gutter.move_to([self.panel.get_left()[0] + 0.06, y, 0]))

    @verb
    def highlight(self, first: int, last: int | None = None, color: str = T.YELLOW) -> Transform:
        """Animation: a band over lines `first`..`last` with a gutter mark in `color`."""
        band = hidden(self._band(first, last or first, color, 0.16))
        self.bands.add(band)
        return reveal(band)

    def note(self, line: int, words: str, color: str = T.YELLOW, icon_kind: str | None = None):
        """A Tag pointing at line `line`: right of the panel when the stage has room, else under it.
        Show it like any mobject: self.show(code.note(3, "locks the table", T.RED))."""
        from .parts import Tag

        tag = Tag(words, color, icon_kind, width=4.2)
        tag.move_to([self.panel.get_right()[0] + 0.3 + tag.width / 2, self.line_y(line), 0])
        if tag.get_right()[0] > T.RIGHT + 0.05:
            tag.next_to(self.panel, DOWN, buff=0.3).align_to(self.panel, LEFT)
        tag._cv_name = f'Code note "{words}"'
        return tag

    @verb
    def change(self, new_src: str, run_time: float = 2.4) -> Animation:
        """Animation: edit the code in place. Removed text turns red and leaves, kept text glides
        to its new place, added text arrives in green with a green gutter mark on its line."""
        target = Code(new_src, self.lang, self.path, self.size, self.max_w, self.max_h)
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


@remakeable
class Eq(VGroup):
    """A line of math in the serif voice, e.g. Eq("$100.00 ÷ 3"); colors maps substrings to colors."""

    _state = ("expr", "body", "_tokens")

    def __init__(self, expr: str, size: float = T.NUMBER, colors: dict[str, str] | None = None,
                 color: str = T.TEXT, width: float = T.RIGHT - T.LEFT):
        super().__init__()
        wide = _width(expr, size, T.SERIF)
        if wide > width:
            size = max(T.MIN_PX["number"], size * width / wide)
            if _width(expr, size, T.SERIF) > width + 1e-6:
                problem(f'Eq "{expr[:28]}" does not fit {width * T.UNIT_PX:.0f} px at the '
                        f'{T.MIN_PX["number"]:.0f} px minimum: split it or cut terms')
        self.expr, self.size, self.color_, self.max_w = expr, size, color, width
        self.body = text(expr, size=size, color=color, font=T.SERIF, kind="number")
        glyphs = self.body.submobjects  # one per character, spaces included (disable_ligatures)
        for sub, col in (colors or {}).items():
            for m in re.finditer(re.escape(sub), expr):
                for g in glyphs[m.start(): m.end()]:
                    g.set_color(col)
        self._tokens = [(m.group(), glyphs[m.start(): m.end()]) for m in _EQ_TOKEN.finditer(expr)]
        self.add(self.body)
        self._cv_name = f'Eq "{expr[:28]}"'

    @verb
    def change(self, new_expr: str, colors: dict[str, str] | None = None, run_time: float = 1.6) -> Animation:
        """Animation: transform into `new_expr`; shared tokens glide, the rest fade out and in."""
        target = Eq(new_expr, self.size, colors, self.color_, self.max_w).move_to(self.get_center())
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

