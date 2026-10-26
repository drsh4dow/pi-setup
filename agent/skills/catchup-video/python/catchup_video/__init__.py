"""Primitives for narrated catchup videos in Manim. A story does `from catchup_video import *`,
which also brings every public Manim name (Square, FadeIn, UP, ...); the primitives below win
where a name is taken twice (Code)."""

import manim as _manim
from manim import *  # re-exported for stories

from . import theme as T
from .clock import Video, beat, name, over
from .graph import Branches
from .parts import Bars, Grid, Number, Options, Shot, Tag, Tiles, arrow, icon
from .pieces import Compare, Correction, Flow, Tally
from .text import Code, Eq, faded, text

PRIMITIVES = [text, Code, Eq, Number, Branches, Shot, Tiles, Bars, Options, Tag, icon, arrow, Grid, faded,
              over, name]
PIECES = [Flow, Correction, Tally, Compare]
_OURS = [p.__name__ for p in PRIMITIVES + PIECES] + ["T", "Video", "beat"]
__all__ = sorted({n for n in dir(_manim) if not n.startswith("_") and not n.islower()} | set(_OURS))
