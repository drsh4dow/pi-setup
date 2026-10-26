"""Branches: the git graph of the base branch with one branch per PR, which folds into a strip at
the stage's left edge for each PR's chapter, so the picture stays on screen the whole video.

It lays itself out for 1 to 40 PRs: one column while its labels fit at or above the minimum
size (up to 12 PRs), then two or three columns. A title longer than its row is shortened with an
ellipsis, never shrunk below the minimum, and the chapter header after a dive shows it whole.
"""

from __future__ import annotations

import math

import numpy as np
from manim import (
    DOWN,
    LEFT,
    RIGHT,
    UP,
    AnimationGroup,
    CubicBezier,
    Dot,
    Line,
    RoundedRectangle,
    Transform,
    UpdateFromAlphaFunc,
    VGroup,
    VMobject,
    rate_functions,
)

from . import theme as T
from .parts import Tag, icon
from .report import problem
from .text import baseline, label_of, look, mix, remember, text, verb

ROWS_TOP = 3.55  # the overview may use the header row: a dive lifts the title there
BASE_ROOM = 0.55  # under the trunks, for the base branch's name
ROW_EMS = 1.65  # a row's pitch, in ems of its labels
MAX_PRS = 40
MAX_COLUMNS = 3


def _layout(n: int) -> tuple[int, int, float, float]:
    """Columns, rows per column, row pitch, and label size (em px) for `n` PRs."""
    height = ROWS_TOP - T.FLOOR - BASE_ROOM
    for cols in range(1, MAX_COLUMNS + 1):
        rows = math.ceil(n / cols)
        pitch = min(1.9, height / (rows + 0.6))
        size = min(T.LABEL, pitch * T.UNIT_PX / ROW_EMS)
        if size >= T.MIN_PX["label"]:
            return cols, rows, pitch, size
    return MAX_COLUMNS, rows, pitch, T.MIN_PX["label"]  # rows closer than ROW_EMS, still apart


def _cap_middle(t) -> float:
    """The middle of `t`'s digits and capitals: where a row's line meets its label."""
    return baseline(t) + 0.36 * t.font_size * T.PX / T.UNIT_PX


def _shortened(words: str, size: float, room: float, **style) -> VMobject:
    """`words` at `size`, cut at the end with an ellipsis until it fits `room` units."""
    t = text(words, size=size, **style)
    if t.width <= room:
        return t
    keep = max(1, int(len(words) * room / t.width))
    while keep > 1:
        t = text(words[:keep].rstrip() + "\u2026", size=size, **style)
        if t.width <= room:
            return t
        keep -= 1
    return text(words[:1] + "\u2026", size=size, **style)


class Branches(VGroup):
    """The base branch with one branch per PR, ending in the PR's node and title; fits 1 to 40 PRs.

    Play draw() to bring it in, mark()/ring() to show a PR's state, point() to call a PR out, and
    Video.dive(graph, n) / Video.pull_back(graph) to fold it into a strip for PR n's chapter."""

    def __init__(self, prs: dict[int, str], base: str = "main"):
        super().__init__()
        n = len(prs)
        if n > MAX_PRS:
            problem(f"Branches has {n} PRs; it fits {MAX_PRS}: show the ones this video talks about")
        cols, rows, pitch, self.size = _layout(n)
        self.pitch = pitch
        cw = (T.RIGHT - T.LEFT) / cols
        span = rows * pitch
        top = (ROWS_TOP + T.FLOOR + BASE_ROOM) / 2 + span / 2
        reach = 1.2 if cols == 1 else 0.85
        self._rows: dict[int, dict] = {}
        self._v = 1.0
        self._gone: set[int] = set()
        self.trunks: list[Line] = []
        self.strip: Strip | None = None  # the folded graph while a chapter is on
        items = list(prs.items())
        for c in range(cols):
            chunk = items[c * rows:(c + 1) * rows]
            if not chunk:
                break
            xm = T.LEFT + c * cw + 0.15
            ys = [top - 0.6 * pitch - k * pitch for k in range(len(chunk))]
            trunk = Line([xm, top, 0], [xm, ys[-1] - 0.4 * pitch, 0], stroke_color=T.FAINT, stroke_width=4)
            trunk._cv_name = "Branches trunk"
            self.trunks.append(trunk)
            self.add(trunk)
            if c == 0:
                self.base = text(base, size=T.SMALL, color=T.DIM, font=T.MONO, width=cw - 0.3, lines=1)
                self.base.next_to(trunk, DOWN, buff=0.15).align_to(trunk, LEFT).shift(LEFT * 0.15)
                self.base._cv_name = "Branches base"
                self.add(self.base)
            right = T.LEFT + (c + 1) * cw - (0.1 if c == cols - 1 else 0.35)
            for (num, title), y in zip(chunk, ys):
                self._add_row(num, title, xm, y, pitch, reach, right)
        if cols == 1:
            # One column leaves room: center the graph a little left, keeping space for the marks.
            content_right = max(r["label"].get_right()[0] for r in self._rows.values())
            self.shift(RIGHT * max(0.0, (T.RIGHT - 3.6 - content_right) / 2))
        self._remember()
        self._cv_name = "Branches"

    def _add_row(self, num: int, title: str, xm: float, y: float, pitch: float, reach: float, right: float):
        fork = np.array([xm, y + 0.6 * pitch, 0])
        end = np.array([xm + reach, y, 0])
        curve = CubicBezier(fork, [xm, y, 0], [xm + 0.35 * reach, y, 0], end, stroke_color=T.FAINT, stroke_width=4)
        curve._cv_name = f"Branches #{num} branch"
        node = Dot(end, radius=0.13, color=T.BLUE)
        node._cv_name = f"Branches #{num} node"
        number = text(f"#{num}", size=self.size, color=T.DIM, font=T.SERIF)
        number.next_to(node, RIGHT, buff=0.45)
        number.shift(UP * (y - _cap_middle(number)))
        room = right - number.get_right()[0] - 0.2
        name = _shortened(title, self.size, room)
        name.next_to(number, RIGHT, buff=0.2)
        name.shift(UP * (baseline(number) - baseline(name)))
        name._cv_name = f"Branches #{num} title"
        label = VGroup(number, name)
        marks, rings = VGroup(), VGroup()
        # "state" is the row's latest mark as its icon kind and color: what the strip shows.
        self._rows[num] = {"curve": curve, "node": node, "label": label, "number": number, "title": name,
                           "full": title, "marks": marks, "rings": rings, "icons": [], "tag": None, "right": right,
                           "state": None}
        self.add(curve, node, label, marks, rings)

    def _remember(self, mob=None):
        for m in (mob or self).get_family():
            if isinstance(m, VMobject) and not hasattr(m, "_cv_base"):
                m._cv_base = (m.get_fill_opacity(), m.get_stroke_opacity())

    def _fade(self, mob, k: float) -> None:
        """Set `mob` to `k` of its full look under the graph's current visibility."""
        for m in mob.get_family():
            base = getattr(m, "_cv_base", None)
            if base is None:
                continue
            f = 0.0 if id(m) in self._gone else self._v
            m.set_fill(opacity=base[0] * k * f, family=False).set_stroke(opacity=base[1] * k * f, family=False)

    def _cv_parts(self):
        """What must never overlap, for the check: each row's node (with its rings), number,
        title, and marks, and the base branch's name."""
        parts = [("base", self.base)]
        for n, row in self._rows.items():
            parts += [(f"#{n} node", VGroup(row["node"], *row["rings"])), (f"#{n} number", row["number"]),
                      (f"#{n} title", row["title"])]
            parts += [(f"#{n} {label_of(m).removeprefix(f'Branches #{n} ')}", m) for m in row["marks"]]
        return parts

    def node(self, n: int) -> Dot:
        """PR `n`'s node."""
        return self._rows[n]["node"]

    def label(self, n: int) -> VGroup:
        """PR `n`'s number and title beside its node."""
        return self._rows[n]["label"]

    def header_for(self, n: int) -> VGroup:
        """The chapter header PR `n`'s title becomes: the same words, whole, top-left."""
        number = text(f"#{n}", size=T.HEADER, color=T.DIM, font=T.SERIF)
        room = T.RIGHT - T.LEFT - number.width - 0.22
        full = self._rows[n]["full"]
        size = max(T.MIN_PX["label"], T.HEADER * min(1.0, room / text(full, size=T.HEADER).width))
        name = _shortened(full, size, room)
        head = VGroup(number, name).arrange(RIGHT, buff=0.22, aligned_edge=DOWN)
        return head.move_to([T.LEFT, T.HEADER_Y, 0], aligned_edge=LEFT)

    def visibility(self, v: float, hidden=()) -> None:
        """Show the graph at opacity `v` (0..1), keeping the parts in `hidden` out of sight."""
        self._v = v
        self._gone = {id(f) for m in hidden for f in m.get_family()}
        self._fade(self, 1.0)

    @verb
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
                self._fade(m, min(1, max(0, (a - 0.5 * k) / 0.5)))

        return UpdateFromAlphaFunc(self, update, run_time=run_time, introducer=True)

    @verb
    def mark(self, n: int, words: str | None = None, color: str = T.GREEN, icon_kind: str = "check",
             run_time: float = 0.6):
        """Animation: a state mark after PR `n`'s title, e.g. mark(51, "approved"). A row keeps one
        word mark (a new one replaces it) and any number of icon marks (words=None); the title
        shortens to make room. Played inside a chapter, it shows in the strip as its icon at once,
        and whole on pull_back."""
        row = self._rows[n]
        new = (Tag(words, color, icon_kind, size=min(T.SMALL, self.size), height=0.85 * self.pitch) if words
               else icon(icon_kind, color, 0.4))
        new._cv_name = f'Branches #{n} mark "{words}"' if words else f"Branches #{n} {icon_kind}"
        gone = [(row["marks"], row["tag"])] if words and row["tag"] is not None else []
        if words:
            row["tag"] = new
        else:
            row["icons"].append(new)
        row["marks"].add(new)
        self._remember(new)
        self._fade(new, 0.0)

        pieces = [*row["icons"], *([row["tag"]] if row["tag"] is not None else [])]
        need = sum(p.width for p in pieces) + 0.2 * (len(pieces) - 1) + 0.3
        room = row["right"] - row["title"].get_left()[0] - need
        if row["title"].width > room:
            title = _shortened(row["full"], self.size, room)
            if title.width > room + 0.05:
                problem(f"Branches #{n}: its marks take {need * T.UNIT_PX:.0f} px and leave its title no room: "
                        "say the mark in fewer words, or mark it with an icon (mark(n) without words)")
            title.move_to(row["title"], aligned_edge=LEFT)
            title.shift(UP * (baseline(row["title"]) - baseline(title)))
            title._cv_name = f"Branches #{n} title"
            gone.append((row["label"], row["title"]))
            row["label"].add(title)
            self._remember(title)
            self._fade(title, 0.0)
            born = [new, title]
            row["title"] = title
        else:
            born = [new]
        x = row["title"].get_right()[0] + 0.3
        moves = []
        y = row["node"].get_center()[1]
        for p in pieces:
            target = np.array([x + p.width / 2, y, 0])
            if p is new:
                p.move_to(target)
            else:
                moves.append((p, p.get_center().copy(), target))
            x += p.width + 0.2
        row["state"] = ((icon_kind or "dot") if words else icon_kind, color)
        change = self._change(born, gone, moves, run_time)
        if self.strip is None:
            return change
        return AnimationGroup(change, self.strip.mark(n, *row["state"], run_time=run_time))

    @verb
    def ring(self, n: int, color: str = T.YELLOW, run_time: float = 0.6):
        """Animation: a ring around PR `n`'s node: it waits on the viewer."""
        row = self._rows[n]
        ring = icon("ring", color, min(1.0, 0.9 * self.pitch)).move_to(row["node"])  # rings of adjacent rows stay apart
        ring._cv_name = f"Branches #{n} ring"
        row["rings"].add(ring)
        self._remember(ring)
        self._fade(ring, 0.0)
        change = self._change([ring], [], [], run_time)
        if self.strip is None:
            return change
        return AnimationGroup(change, self.strip.ring(n, color, run_time=run_time))

    @verb
    def point(self, n: int, color: str = T.YELLOW, keep: bool = False, run_time: float = 0.8) -> UpdateFromAlphaFunc:
        """Animation: call PR `n` out, its title flashing in `color` and back, or staying in it with keep=True."""
        if self.strip is not None:
            return self.strip.point(n, color, keep, run_time)
        return flash(self._rows[n]["label"], color, keep, run_time)

    def fold(self, n: int, head) -> Fold:
        """The animation that folds the graph into a strip for PR `n`'s chapter: each branch, node,
        ring, and number glides to its place in the strip, each mark fades into its icon there, the
        rest fades, and PR `n`'s title becomes `head`. Video.dive plays it."""
        strip = Strip(self, n)
        pairs = self._pairs(strip)
        hidden = [full for full, _ in pairs if full is not None] + [self.label(n)]
        movers, anims = [], []
        for full, part in pairs:
            mover = full.copy() if full is not None else _clear(part)
            movers.append(mover)
            anims.append(Transform(mover, part))
        flier = self.label(n).copy()
        movers.append(flier)
        anims.append(Transform(flier, head))

        def fade(g, a):
            self.visibility(1 - rate_functions.smooth(min(1.0, 2 * a)), hidden=hidden)

        anims.append(UpdateFromAlphaFunc(self, fade))
        return Fold(anims, movers, strip)

    def unfold(self, head) -> Fold:
        """The animation that grows the strip back into the whole graph, the header returning to its
        row as its title; marks played in the chapter show whole. Video.pull_back plays it."""
        strip = self.strip
        pairs = self._pairs(strip)
        hidden = [full for full, _ in pairs if full is not None] + [self.label(strip.focus)]
        movers, anims = [], []
        for full, part in pairs:
            mover = part.copy()
            movers.append(mover)
            anims.append(Transform(mover, self._shown(full) if full is not None else _clear(part)))
        flier = head.copy()
        movers.append(flier)
        anims.append(Transform(flier, self._shown(self.label(strip.focus))))

        def fade(g, a):
            self.visibility(rate_functions.smooth(max(0.0, 2 * a - 1)), hidden=hidden)

        anims.append(UpdateFromAlphaFunc(self, fade))
        return Fold(anims, movers, strip)

    def _pairs(self, strip: Strip) -> list:
        """Each strip part with the part of the whole graph it folds from, or None when it has none."""
        pairs = [(self.trunks[0], strip.trunk), (None, strip.band)]
        for k, row in self._rows.items():
            part = strip.rows[k]
            pairs += [(row["curve"], part["curve"]), (row["node"], part["node"])]
            if part["ring"] is not None:
                pairs.append((row["rings"][-1], part["ring"]))
            if part["number"] is not None:
                pairs.append((row["number"] if k != strip.focus else None, part["number"]))
            if part["pip"] is not None:
                pairs.append((None, part["pip"]))  # a mark fades between its tag and its icon in place
        return pairs

    def _shown(self, mob):
        """A copy of `mob` with the look it has when the graph is fully shown."""
        shown = mob.copy()
        for m in shown.get_family():
            base = getattr(m, "_cv_base", None)
            if base is not None:
                m.set_fill(opacity=base[0], family=False).set_stroke(opacity=base[1], family=False)
        return shown

    def _change(self, born, gone, moves, run_time):
        def update(g, a):
            s = rate_functions.smooth(a)
            # What leaves is gone before what replaces it shows, so the two never read as one.
            for m in born:
                self._fade(m, rate_functions.smooth(max(0.0, 2 * a - 1)))
            for _, m in gone:
                self._fade(m, 1 - rate_functions.smooth(min(1.0, 2 * a)))
            for m, p0, p1 in moves:
                m.move_to(p0 + (p1 - p0) * s)
            if a >= 1:
                for parent, m in gone:
                    parent.remove(m)

        return UpdateFromAlphaFunc(self, update, run_time=run_time)


def flash(label, color: str, keep: bool, run_time: float) -> UpdateFromAlphaFunc:
    """Animation: `label` swells a little to the right of its left edge and tints to `color`, then
    returns (keeping the tint with `keep`), so it never reaches what sits left of it (its node)."""
    parts = [(m, m.copy()) for m in label.get_family() if m.has_points()]
    left = label.get_left()

    def update(g, a):
        swell = rate_functions.there_and_back(a)
        tint = rate_functions.smooth(a) if keep else swell
        for m, m0 in parts:
            m.become(m0)
            m.set_fill(mix(m0.get_fill_color(), color, tint), family=False)
        g.scale(1 + 0.06 * swell, about_point=left)

    return UpdateFromAlphaFunc(label, update, run_time=run_time)


class Fold:
    """A fold or unfold of the graph: its animations, the stand-ins they move (taken off stage when
    they end), and the strip."""

    def __init__(self, anims: list, movers: list, strip: Strip):
        self.anims, self.movers, self.strip = anims, movers, strip


def _clear(mob):
    """A fully transparent copy of `mob`: what a part that has no counterpart fades from or to."""
    return mob.copy().set_opacity(0)


STRIP_PITCH = 0.62  # the strip's largest row pitch
STRIP_GAP = 0.5  # between the strip and the chapter's pieces


class Strip(VGroup):
    """The graph folded to one column at the stage's left edge while PR `focus`'s chapter plays:
    every PR's branch and node, its number while numbers fit at the minimum size (up to about 15
    PRs), and its latest mark as an icon in the mark's color. The focused row is highlighted."""

    def __init__(self, graph: Branches, focus: int):
        super().__init__()
        self.focus = focus
        n = len(graph._rows)
        pitch = min(STRIP_PITCH, (T.TOP - T.FLOOR - 0.3) / n)
        size = min(T.SMALL, pitch * T.UNIT_PX / 1.3)
        numbered = size >= T.MIN_PX["label"]
        size = max(size, T.MIN_PX["label"])
        self.pip_size = min(0.3, 0.8 * pitch)
        radius = min(0.1, 0.3 * pitch)
        self.ring_size = min(pitch, (radius + 0.1) / 0.42)
        top = (T.TOP + T.FLOOR) / 2 + n * pitch / 2
        x0 = T.LEFT + 0.1
        xn = x0 + 0.35
        numbers = {k: text(f"#{k}", size=size, color=T.TEXT if k == focus else T.DIM, font=T.SERIF)
                   for k in graph._rows if numbered or k == focus}
        num_x = xn + radius + 0.15
        pip_x = num_x + max(t.width for t in numbers.values()) + 0.15 if numbered else xn + radius + 0.15
        self.trunk = Line([x0, top, 0], [x0, top - (n - 0.2) * pitch, 0], stroke_color=T.FAINT, stroke_width=3)
        self.rows: dict[int, dict] = {}
        for k, (num, row) in enumerate(graph._rows.items()):
            y = top - (k + 0.5) * pitch
            self.rows[num] = self._row(num, row, y, x0, xn, radius * (1.3 if num == focus else 1.0), pitch)
            self.rows[num]["pip_at"] = np.array([pip_x + self.pip_size / 2, y, 0])
            number = numbers.get(num)
            if number is not None:
                at = num_x if numbered else pip_x + 1.1 * self.pip_size + 0.15
                number.move_to([at, y, 0], aligned_edge=LEFT).shift(UP * (y - _cap_middle(number)))
                self.rows[num]["number"] = number
            if row["state"] is not None:
                self.rows[num]["pip"] = icon(*row["state"], self.pip_size).move_to(self.rows[num]["pip_at"])
        self.right = max(pip_x + 1.1 * self.pip_size, *(t.get_right()[0] for t in numbers.values()))
        focused = self.rows[focus]["node"].get_y()
        self.band = RoundedRectangle(width=self.right - x0 + 0.3, height=0.94 * pitch, corner_radius=min(0.12, 0.3 * pitch),
                                     stroke_color=T.FAINT, stroke_width=1.5, fill_color=T.PANEL, fill_opacity=1)
        self.band.move_to([(x0 - 0.15 + self.right + 0.15) / 2, focused, 0])
        self.add(self.band, self.trunk)
        for part in self.rows.values():
            self.add(*(m for m in (part["curve"], part["node"], part["ring"], part["number"], part["pip"]) if m is not None))
        self._cv_name, self._cv_chrome = "Branches strip", True

    def _row(self, num: int, row: dict, y: float, x0: float, xn: float, radius: float, pitch: float) -> dict:
        fork = np.array([x0, y + 0.5 * pitch, 0])
        end = np.array([xn, y, 0])
        dim = 1.0 if num == self.focus else 0.5
        curve = CubicBezier(fork, [x0, y, 0], [x0 + 0.1, y, 0], end, stroke_color=T.FAINT, stroke_width=3)
        node = Dot(end, radius=radius, color=T.BLUE, fill_opacity=dim)
        ring = None
        if len(row["rings"]):
            ring = icon("ring", row["rings"][-1].get_stroke_color(), self.ring_size).move_to(end)
        return {"curve": curve, "node": node, "ring": ring, "number": None, "pip": None}

    def _cv_parts(self):
        """What must never overlap, for the check: each row's node (with its ring), number, and mark."""
        parts = []
        for num, part in self.rows.items():
            parts.append((f"#{num} node", VGroup(*(m for m in (part["node"], part["ring"]) if m is not None))))
            parts += [(f"#{num} {what}", part[what]) for what in ("number", "pip") if part[what] is not None]
        return parts

    @verb
    def mark(self, n: int, kind: str, color: str, run_time: float = 0.6) -> UpdateFromAlphaFunc:
        """Animation: PR `n`'s latest mark, as an icon; it replaces the one before."""
        part = self.rows[n]
        old, new = part["pip"], icon(kind, color, self.pip_size).move_to(part["pip_at"])
        part["pip"] = new
        self.add(new)
        return self._swap(old, new, run_time)

    @verb
    def ring(self, n: int, color: str, run_time: float = 0.6) -> UpdateFromAlphaFunc:
        """Animation: a ring around PR `n`'s node; it replaces the one before."""
        part = self.rows[n]
        old = part["ring"]
        part["ring"] = icon("ring", color, self.ring_size).move_to(part["node"])
        self.add(part["ring"])
        return self._swap(old, part["ring"], run_time)

    @verb
    def point(self, n: int, color: str, keep: bool, run_time: float) -> UpdateFromAlphaFunc:
        """Animation: call PR `n` out in the strip, its number (or node) flashing in `color`."""
        part = self.rows[n]
        return flash(part["number"] if part["number"] is not None else part["node"], color, keep, run_time)

    def _swap(self, old, new, run_time: float) -> UpdateFromAlphaFunc:
        remember(new)
        look(new, 0)

        def update(g, a):
            if old is not None:
                look(old, 1 - rate_functions.smooth(min(1.0, 2 * a)))
            look(new, rate_functions.smooth(max(0.0, 2 * a - 1)))
            if a >= 1 and old is not None and old in self.submobjects:
                self.remove(old)

        if old is not None:
            remember(old)
        return UpdateFromAlphaFunc(self, update, run_time=run_time)
