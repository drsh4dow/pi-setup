"""Branches: the git graph of the base branch with one branch per PR, which the camera dives into."""

from __future__ import annotations

import numpy as np
from manim import DOWN, LEFT, RIGHT, CubicBezier, Dot, Line, UpdateFromAlphaFunc, VGroup, VMobject, rate_functions

from . import theme as T
from .parts import Tag, icon
from .text import hidden, reveal, text


class Branches(VGroup):
    """The base branch with one branch per PR, ending in the PR's node and title.

    Play draw() to bring it in, mark()/ring() to show a PR's state, and Video.dive(graph, n) /
    Video.pull_back(graph) to fly the camera into a PR for its chapter and back out."""

    def __init__(self, prs: dict[int, str], base: str = "main", gap: float | None = None):
        super().__init__()
        n = len(prs)
        gap = gap or min(1.9, (T.TOP - T.FLOOR) / (n + 0.4))
        mid = (T.TOP + T.FLOOR) / 2
        ys = [mid + (n - 1) / 2 * gap - k * gap for k in range(n)]
        xm, xn = -5.7, -4.5
        self.trunk = Line([xm, ys[0] + 0.9 * gap, 0], [xm, ys[-1] - 0.5 * gap, 0], stroke_color=T.FAINT,
                          stroke_width=4)
        self.base = text(base, size=T.SMALL, color=T.DIM, font=T.MONO).next_to(self.trunk, DOWN, buff=0.15)
        self.base.align_to(self.trunk, LEFT).shift(LEFT * 0.2)
        self.add(self.trunk, self.base)
        self._rows: dict[int, dict] = {}
        for (num, title), y in zip(prs.items(), ys):
            fork = np.array([xm, y + 0.6 * gap, 0])
            end = np.array([xn, y, 0])
            curve = CubicBezier(fork, [xm, y, 0], [xm + 0.4, y, 0], end, stroke_color=T.FAINT, stroke_width=4)
            node = Dot(end, radius=0.13, color=T.BLUE)
            label = self._label(num, title, T.LABEL).next_to(node, RIGHT, buff=0.55)
            marks = VGroup()
            self._rows[num] = {"node": node, "label": label, "marks": marks, "tags": [], "title": title}
            self.add(curve, node, label, marks)
        # Centered a little left of the stage, leaving room for the marks that join the titles.
        self.shift(RIGHT * (-1.2 - self.get_center()[0]))
        self._v = 1.0
        self._remember()
        self._cv_name = "Branches"

    @staticmethod
    def _label(num: int, title: str, size: float) -> VGroup:
        return VGroup(text(f"#{num}", size=size, color=T.DIM, font=T.SERIF),
                      text(title, size=size)).arrange(RIGHT, buff=0.22, aligned_edge=DOWN)

    def _remember(self):
        for m in self.get_family():
            if isinstance(m, VMobject) and not hasattr(m, "_cv_base"):
                m._cv_base = (m.get_fill_opacity(), m.get_stroke_opacity())

    def node(self, n: int) -> Dot:
        """PR `n`'s node, the dot the camera dives into."""
        return self._rows[n]["node"]

    def label(self, n: int) -> VGroup:
        """PR `n`'s number and title beside its node."""
        return self._rows[n]["label"]

    def header_for(self, n: int) -> VGroup:
        """The chapter header PR `n`'s title becomes: the same words, top-left."""
        head = self._label(n, self._rows[n]["title"], T.HEADER)
        return head.move_to([T.LEFT, T.HEADER_Y, 0], aligned_edge=LEFT)

    def visibility(self, v: float, hidden: int | None = None) -> None:
        """Show the graph at opacity `v` (0..1), keeping PR `hidden`'s title out of sight."""
        self._v = v
        gone = {id(m) for m in self._rows[hidden]["label"].get_family()} if hidden is not None else set()
        for m in self.get_family():
            base = getattr(m, "_cv_base", None)
            if base is not None and not hasattr(m, "_cv_full"):
                k = 0.0 if id(m) in gone else v
                m.set_fill(opacity=base[0] * k, family=False).set_stroke(opacity=base[1] * k, family=False)

    def draw(self, run_time: float = 2.0) -> UpdateFromAlphaFunc:
        """Animation: grow the base branch, then each PR's branch, node, and title in turn."""
        lines = [m for m in self.submobjects if isinstance(m, (Line, CubicBezier))]
        full = [m.copy() for m in lines]
        rest = [m for m in self.submobjects if m not in lines]
        order = {id(m): k for k, m in enumerate(self.submobjects)}

        def update(g, a):
            for m, f in zip(lines, full):
                k = order[id(m)] / len(self.submobjects)
                m.pointwise_become_partial(f, 0, rate_functions.smooth(min(1, max(0, (a - 0.5 * k) / 0.5))))
            for m in rest:
                k = order[id(m)] / len(self.submobjects)
                s = min(1, max(0, (a - 0.5 * k) / 0.5))
                for f in m.get_family():
                    base = getattr(f, "_cv_base", None)
                    if base is not None and not hasattr(f, "_cv_full"):
                        f.set_fill(opacity=base[0] * s, family=False).set_stroke(opacity=base[1] * s, family=False)

        return UpdateFromAlphaFunc(self, update, run_time=run_time, introducer=True)

    def mark(self, n: int, words: str | None = None, color: str = T.GREEN, icon_kind: str = "check",
             run_time: float = 0.6):
        """Animation: a state mark after PR `n`'s title, e.g. mark(51, "approved"); play it inside
        a chapter and it appears on pull_back."""
        row = self._rows[n]
        mark = Tag(words, color, icon_kind) if words else icon(icon_kind, color, 0.4)
        mark.next_to(row["tags"][-1] if row["tags"] else row["label"], RIGHT, buff=0.3)
        row["tags"].append(mark)
        return self._attach(row["marks"], mark, run_time)

    def ring(self, n: int, color: str = T.YELLOW, run_time: float = 0.6):
        """Animation: a ring around PR `n`'s node: it waits on the viewer."""
        node = self._rows[n]["node"]
        ring = icon("ring", color, 1.0).move_to(node)
        return self._attach(self._rows[n]["marks"], ring, run_time)

    def _attach(self, group, mob, run_time):
        group.add(mob)
        self._remember()
        hidden(mob)
        target = mob._cv_full.copy()
        for m in target.get_family():
            if isinstance(m, VMobject):
                m.set_fill(opacity=m.get_fill_opacity() * self._v, family=False)
                m.set_stroke(opacity=m.get_stroke_opacity() * self._v, family=False)
        anim = reveal(mob, target)
        anim.run_time = run_time
        del mob._cv_full
        return anim
