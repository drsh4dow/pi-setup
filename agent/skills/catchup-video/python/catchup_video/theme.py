"""Palette, type, sizes, and the stage. Each color keeps one meaning for the whole video."""

import json
from pathlib import Path

import manimpango

FONTS = Path(__file__).resolve().parents[2] / "fonts"
for _font in sorted(FONTS.glob("*.[ot]tf")):
    manimpango.register_font(str(_font))

# ---- color: one meaning each ----------------------------------------------------
BG = "#0F1218"  # the stage
PANEL = "#161B24"  # code, screenshot, and option panels
FAINT = "#2A3140"  # rules, frames, branch lines, ghosts
DIM = "#7D8597"  # secondary text; none, missing, not yet
TEXT = "#E6E9EF"  # primary text
BLUE = "#58C4DD"  # facts and data: money, counts, measurements
YELLOW = "#F2C14E"  # waiting on the viewer: decisions and asks
RED = "#FC6255"  # the problem or the cost; removed code
GREEN = "#83C167"  # fixed, passing, approved; added code

# Syntax stays in muted violets so the meaning colors stay free on top of code.
SYNTAX = {
    "keyword": "#B39DDB",
    "name": "#D7DCE6",
    "function": "#E6E9EF",
    "number": "#D9A7C7",
    "string": "#C8B6E2",
    "comment": "#5F6878",
    "punct": "#8A93A3",
}

# ---- type -----------------------------------------------------------------------
SANS = "Inter"  # labels, tags, options
SERIF = "CMU Serif"  # numbers, equations, the PR header: the math voice
MONO = "JetBrains Mono NL"  # code, without ligatures

# Sizes are em pixels at 1080p. Manim's font_size is em_px / PX: a Text at
# font_size 100 in any of the three fonts measures a 187.5 px em at 1080p
# (cap height 1.011 units in Inter = 136.5 px, cap height 0.727 em).
PX = 1.875
LABEL = 44
SMALL = 38
CODE = 36
NUMBER = 68
HEADER = 52


# The smallest em size, in pixels at 1080p, each kind of text may have on screen. The check
# reads the same file, so a primitive that fits itself and the check agree on the floor.
MIN_PX: dict[str, float] = json.loads((Path(__file__).with_name("limits.json")).read_text())["min_px"]


def fs(px: float) -> float:
    """Manim font_size for an em of `px` pixels at 1080p."""
    return px / PX


# ---- stage (Manim units; the frame is 14.22 x 8, 135 px per unit at 1080p) --------
LEFT, RIGHT = -6.6, 6.6
TOP = 2.9  # below the header row
HEADER_Y = 3.45
CEIL = 3.7  # the top of the stage while no chapter header is pinned
FLOOR = -2.6  # captions own the band below this line
UNIT_PX = 135  # pixels per Manim unit at 1080p


class Stage:
    """Where a beat's pieces go: its left edge moves right while a chapter's graph strip holds the
    left of the frame. The clock sets it; Grid, beside, and the clock's own fitting read it. A
    process renders one Video, so one stage serves it."""

    def __init__(self) -> None:
        self.left = LEFT


STAGE = Stage()
