"""Pieces for the moves explainers repeat: a pipeline, a correction, a tally, a before and after.

Each fits itself to the room it is given and keeps its text at or above the minimum size. Each
is one mobject: place it anywhere (Grid.put, beside, move_to) and play its verbs.
"""

from __future__ import annotations

import numpy as np
from manim import (
    DOWN,
    LEFT,
    ORIGIN,
    RIGHT,
    UP,
    Dot,
    Group,
    Line,
    RoundedRectangle,
    UpdateFromAlphaFunc,
    VGroup,
    rate_functions,
)

from . import theme as T
from .parts import Number, Tag, Tiles, arrow
from .text import fit, label_of, look, mix, remakeable, remember, text, verb

WIDE = T.RIGHT - T.LEFT


def _window(a: float, k: int, n: int, span: float = 0.5) -> float:
    """Progress of the k-th of n staggered parts at overall progress `a`."""
    start = (1 - span) * k / max(1, n - 1)
    return rate_functions.smooth(min(1.0, max(0.0, (a - start) / span)))


def _words(item, width: float, height: float, size: float = T.LABEL, color: str = T.TEXT):
    """`item` itself fitted to width x height, or its words wrapped to the width."""
    if isinstance(item, str):
        return fit(text(item, size=size, color=color, width=width, lines=3, align=ORIGIN), width, height)
    return fit(item, width, height)


@remakeable
class Flow(VGroup):
    """Steps joined by arrows, left to right, fit to `width`: a pipeline, a request path, a rollout.

    Flow(["open PR", "CI", "deploy", "prod"]); grow() brings it in step by step, light(i) colors a
    step, flag(i, "no human") hangs a note under it, run() sends a dot along it."""

    def __init__(self, steps: list[str], width: float = WIDE, color: str = T.TEXT, arrows: bool = True):
        n = len(steps)
        gap = (0.75 if n <= 4 else 0.45) if arrows else 0.35
        self.cell = (width - gap * (n - 1)) / n
        self.color_ = color
        self.steps: list[VGroup] = []
        for k, s in enumerate(steps):
            label = text(s, size=T.LABEL, color=color, width=self.cell - 0.4, lines=2, align=ORIGIN)
            box = RoundedRectangle(width=min(self.cell, label.width + 0.4 + 0.2 * (n <= 4)), height=label.height + 0.5,
                                   corner_radius=0.14, stroke_color=T.FAINT, stroke_width=2.5, fill_color=T.PANEL,
                                   fill_opacity=1)
            step = VGroup(box, label.move_to(box))
            step.move_to([k * (self.cell + gap), 0, 0])
            step._cv_name = f'Flow step "{s}"'
            self.steps.append(step)
        self.arrows = [arrow(a, b) for a, b in zip(self.steps, self.steps[1:])] if arrows else []
        for a in self.arrows:
            a._cv_name = "Flow arrow"
        self.notes = VGroup()
        super().__init__(*self.steps, *self.arrows, self.notes)
        self.move_to(ORIGIN)
        remember(self)
        self._cv_name = "Flow"

    def _cv_parts(self):
        """What must never overlap, for the check: each step and each note."""
        return [(label_of(m).removeprefix("Flow "), m) for m in [*self.steps, *self.notes]]

    @verb
    def grow(self, run_time: float = 1.6) -> UpdateFromAlphaFunc:
        """Animation: bring the steps in from left to right, each arrow before its step."""
        order = [self.steps[0]] + [m for pair in zip(self.arrows, self.steps[1:]) for m in pair] \
            if self.arrows else list(self.steps)

        def update(m, a):
            for k, part in enumerate(order):
                look(part, _window(a, k, len(order)))

        return UpdateFromAlphaFunc(self, update, run_time=run_time, introducer=True)

    @verb
    def light(self, i: int, color: str = T.GREEN, run_time: float = 0.6) -> UpdateFromAlphaFunc:
        """Animation: color step `i`'s outline and words in `color`."""
        box, label = self.steps[i]
        b0, l0 = getattr(box, "_cv_color", T.FAINT), getattr(label, "_cv_color", self.color_)
        box._cv_color = label._cv_color = color

        def update(m, a):
            box.set_stroke(mix(b0, color, a), width=2.5 + 1.5 * a)
            label.set_fill(mix(l0, color, a))

        return UpdateFromAlphaFunc(self, update, run_time=run_time)

    @verb
    def flag(self, i: int, words: str, color: str = T.RED, icon_kind: str | None = "nobody",
             run_time: float = 0.6) -> UpdateFromAlphaFunc:
        """Animation: a note under step `i`, e.g. flag(2, "no human checks it"); icon "nobody" by default."""
        tag = Tag(words, color, icon_kind, width=min(WIDE, 2 * self.cell + 0.75))
        tag.next_to(self.steps[i], DOWN, buff=0.3)
        # A note wider than its step stacks under any note it would reach, never over it.
        x0, x1 = tag.get_left()[0], tag.get_right()[0]
        reached = [n for n in self.notes if n.get_left()[0] < x1 and n.get_right()[0] > x0]
        if reached:
            tag.next_to(min(reached, key=lambda n: n.get_bottom()[1]), DOWN, buff=0.3)
            tag.set_x(self.steps[i].get_x())
        tag._cv_step, tag._cv_name = i, f'Flow note "{words}"'
        self.notes.add(tag)
        remember(tag)
        look(tag, 0)

        def update(m, a):
            look(tag, rate_functions.smooth(a))

        return UpdateFromAlphaFunc(self, update, run_time=run_time)

    @verb
    def run(self, color: str = T.BLUE, upto: int | None = None, run_time: float = 2.0) -> UpdateFromAlphaFunc:
        """Animation: a dot travels from the first step to step `upto` (the last by default)."""
        last = len(self.steps) - 1 if upto is None else upto
        points = [s.get_center() for s in self.steps[: last + 1]]
        dot = Dot(points[0], radius=0.11, color=color).set_opacity(0)
        self.add(dot)

        def update(m, a):
            s = rate_functions.smooth(a) * (len(points) - 1)
            k = min(int(s), len(points) - 2) if len(points) > 1 else 0
            p = points[k] if len(points) == 1 else points[k] + (points[k + 1] - points[k]) * (s - k)
            dot.move_to(p).set_opacity(min(1.0, 6 * a, 6 * (1 - a)))

        return UpdateFromAlphaFunc(self, update, run_time=run_time)


@remakeable
class Correction(VGroup):
    """Something said earlier, struck through, then the true version under it:
    Correction("all 12 tests pass", "11 pass, 1 skipped"); play strike(), then fix()."""

    def __init__(self, said: str, actual: str, label: str = "earlier I said", width: float = 10.0):
        self.label = text(label, size=T.SMALL, color=T.DIM, width=width, lines=1)
        self.said = text(said, size=T.LABEL + 8, width=width)
        self.actual = text(actual, size=T.LABEL + 8, color=T.GREEN, width=width)
        VGroup(self.label, self.said, self.actual).arrange(DOWN, aligned_edge=LEFT, buff=0.35)
        self.actual.shift(DOWN * 0.35)
        self.line = Line(self.said.get_left() + LEFT * 0.12, self.said.get_right() + RIGHT * 0.12,
                         stroke_color=T.RED, stroke_width=7)
        self.line._cv_name = "Correction strike"
        super().__init__(self.label, self.said, self.line, self.actual)
        remember(self)
        look(self.line, 0)
        look(self.actual, 0)
        self._cv_name = f'Correction "{said[:24]}"'

    def _cv_parts(self):
        """What must never overlap, for the check: the label, what was said, and what is true."""
        return [("label", self.label), ("said", self.said), ("actual", self.actual)]

    @verb
    def strike(self, run_time: float = 0.8) -> UpdateFromAlphaFunc:
        """Animation: a red line crosses out what was said, which dims."""
        full = self.line.copy()
        c0 = T.TEXT

        def update(m, a):
            s = rate_functions.smooth(a)
            self.line.pointwise_become_partial(full, 0, max(1e-3, s))
            look(self.line, 1)
            self.said.set_fill(mix(c0, T.DIM, s))

        return UpdateFromAlphaFunc(self, update, run_time=run_time)

    @verb
    def fix(self, run_time: float = 0.8) -> UpdateFromAlphaFunc:
        """Animation: the true version rises in under it."""
        end = self.actual.get_center().copy()

        def update(m, a):
            s = rate_functions.smooth(a)
            self.actual.move_to(end + DOWN * 0.2 * (1 - s))
            look(self.actual, s)

        return UpdateFromAlphaFunc(self, update, run_time=run_time)


@remakeable
class Tally(VGroup):
    """A count split into kinds, one tile per item over a legend:
    Tally([("pass", 11, T.GREEN), ("skipped", 1, T.DIM)]). count() brings the tiles in one by one
    while the legend counts up; change(groups) moves items between kinds, as when a count was wrong."""

    def __init__(self, groups: list[tuple[str, int, str]], cols: int | None = None, width: float = 6.0):
        n = sum(c for _, c, _ in groups)
        self.cols = cols or min(n, 20)
        step = min(0.8, width / self.cols)
        self.tiles = Tiles(n, cols=self.cols, size=0.78 * step, gap=0.22 * step)
        self._paint(self.tiles, groups)
        self.legend = self._legend(groups, width)
        self.legend.next_to(self.tiles, DOWN, buff=0.45)
        self.groups = groups
        super().__init__(self.tiles, self.legend)
        remember(self)
        self._cv_name = "Tally"

    def _cv_parts(self):
        """What must never overlap, for the check: the tiles and each kind in the legend."""
        return [("tiles", self.tiles), *((f'legend "{name}"', item) for (name, _, _), item in zip(self.groups, self.legend))]

    @staticmethod
    def _paint(tiles, groups) -> None:
        k = 0
        for _, count, color in groups:
            for t in tiles[k:k + count]:
                t.set_fill(color)
            k += count

    def _legend(self, groups, width) -> VGroup:
        items = []
        for name, count, color in groups:
            num = Number(count, size=T.LABEL + 10, color=color)
            items.append(VGroup(num, text(name, size=T.LABEL, color=T.DIM)).arrange(RIGHT, buff=0.18,
                                                                                     aligned_edge=DOWN))
        legend = VGroup(*items).arrange(RIGHT, buff=0.7)
        legend._cv_name = "Tally legend"
        return fit(legend, width)

    @verb
    def count(self, run_time: float = 1.6) -> UpdateFromAlphaFunc:
        """Animation: tiles appear one by one, and each kind's number counts up with them."""
        ticks = []
        for item in self.legend:
            num, value = item[0], item[0].value
            num.value = 0
            ticks.append(num.tick(value))

        def update(m, a):
            for k, tile in enumerate(self.tiles):
                look(tile, _window(a, k, len(self.tiles), 0.3))
            for t, item in zip(ticks, self.legend):
                t.update_function(t.mobject, a)
                look(item[1], min(1.0, 3 * a))

        return UpdateFromAlphaFunc(self, update, run_time=run_time, introducer=True)

    @verb
    def change(self, groups: list[tuple[str, int, str]], run_time: float = 1.2) -> UpdateFromAlphaFunc:
        """Animation: recolor the tiles into new kinds and swap in their legend."""
        if sum(c for _, c, _ in groups) != len(self.tiles):
            raise ValueError(f"Tally.change: the new kinds count {sum(c for _, c, _ in groups)} items, "
                             f"the tally has {len(self.tiles)}")
        before = [t.get_fill_color() for t in self.tiles]
        target = self.tiles.copy()
        self._paint(target, groups)
        after = [t.get_fill_color() for t in target]
        old = self.legend
        new = self._legend(groups, max(old.width, 4.0)).move_to(old)
        remember(new)
        look(new, 0)
        self.add(new)
        self.legend, self.groups = new, groups

        def update(m, a):
            s = rate_functions.smooth(a)
            for t, c0, c1 in zip(self.tiles, before, after):
                t.set_fill(mix(c0, c1, s))
            look(old, 1 - min(1.0, 2 * s))
            look(new, max(0.0, 2 * s - 1))
            if a >= 1 and old in self.submobjects:
                self.remove(old)

        return UpdateFromAlphaFunc(self, update, run_time=run_time)


@remakeable
class Compare(Group):
    """Two things side by side under their labels, each fit to half of `width`:
    Compare(Shot("before.png"), Shot("after.png")), or two strings. The right side starts hidden:
    reveal() brings it in with the arrow between them."""

    def __init__(self, left, right, labels: tuple[str, str] = ("before", "after"),
                 colors: tuple[str, str] = (T.RED, T.GREEN), width: float = WIDE, height: float = 4.8):
        half = (width - 1.2) / 2
        sides = []
        for item, label, color in zip((left, right), labels, colors):
            head = text(label, size=T.SMALL, color=color, width=half, lines=1)
            body = _words(item, half, height - head.height - 0.3)
            sides.append(Group(head, body).arrange(DOWN, buff=0.3))
        self.left, self.right = sides
        self.left.move_to([-(half + 1.2) / 2, 0, 0], aligned_edge=UP)
        self.right.move_to([(half + 1.2) / 2, 0, 0], aligned_edge=UP)
        top = max(self.left.get_top()[1], self.right.get_top()[1])
        self.left.shift(UP * (top - self.left.get_top()[1]))
        self.right.shift(UP * (top - self.right.get_top()[1]))
        self.left._cv_name, self.right._cv_name = f'Compare "{labels[0]}"', f'Compare "{labels[1]}"'
        mid = (self.left[1].get_center()[1] + self.right[1].get_center()[1]) / 2
        self.arrow = arrow(np.array([self.left.get_right()[0] + 0.1, mid, 0]),
                           np.array([self.right.get_left()[0] - 0.1, mid, 0]))
        super().__init__(self.left, self.arrow, self.right)
        self.move_to(ORIGIN)
        remember(self)
        look(self.right, 0)
        look(self.arrow, 0)
        self._cv_name = "Compare"

    def _cv_parts(self):
        """What must never overlap, for the check: the two sides."""
        return [(self.left._cv_name.removeprefix("Compare "), self.left),
                (self.right._cv_name.removeprefix("Compare "), self.right)]

    @verb
    def reveal(self, run_time: float = 1.0) -> UpdateFromAlphaFunc:
        """Animation: the arrow grows and the right side fades in after it."""
        end = self.right.get_center().copy()

        def update(m, a):
            look(self.arrow, _window(a, 0, 2))
            s = _window(a, 1, 2)
            self.right.move_to(end + LEFT * 0.25 * (1 - s))
            look(self.right, s)

        return UpdateFromAlphaFunc(self, update, run_time=run_time)
