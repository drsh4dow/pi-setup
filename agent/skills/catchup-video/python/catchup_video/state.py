"""What a beat's frames depend on, hashed into the key its render is cached under.

A beat draws the same frames whenever these agree: the toolkit, the render quality, the story's
code outside its beats, the beat's own code, the images that code names, the beat's timing in
frames from its own start, and everything on stage (and held by the story) when it starts. The
state is read from Manim's own mobjects, so an edit to an earlier beat that leaves the stage as
it was does not redraw the beats after it.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from manim import ImageMobject, Mobject, Text, VMobject

PACKAGE = Path(__file__).resolve().parent
SKILL = PACKAGE.parents[1]
_VOLATILE = {"original_id"}  # Manim's str(id(...)): differs run to run, never drawn
_ASSET = re.compile(r"""["']([^"'\n]+\.(?:png|jpe?g|gif|webp|svg))["']""", re.IGNORECASE)


@lru_cache(maxsize=1)
def toolkit() -> str:
    """The toolkit's own sources, limits, fonts, and locked dependencies."""
    h = hashlib.sha256()
    files = [*sorted(PACKAGE.glob("*.py")), PACKAGE / "limits.json", SKILL / "python" / "uv.lock",
             *sorted((SKILL / "fonts").glob("*.[ot]tf"))]
    for f in files:
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def _scalar(v) -> bool:
    if isinstance(v, tuple):
        return all(_scalar(x) for x in v)
    return v is None or isinstance(v, (bool, int, float, str))


class _Hasher:
    def __init__(self) -> None:
        self.h = hashlib.sha256()
        self.seen: dict[int, int] = {}

    def put(self, *parts) -> None:
        for p in parts:
            self.h.update(p if isinstance(p, bytes) else repr(p).encode())

    def array(self, a) -> None:
        self.put(np.ascontiguousarray(np.round(np.asarray(a, dtype=float), 4) + 0.0).tobytes())

    def mob(self, m: Mobject) -> None:
        if id(m) in self.seen:
            self.put("ref", self.seen[id(m)])
            return
        self.seen[id(m)] = len(self.seen)
        for f in m.get_family():
            self.put(type(f).__name__, f.z_index)
            if isinstance(f, VMobject):
                self.array(f.points)
                self.array(f.fill_rgbas)
                self.array(f.stroke_rgbas)
                self.put(f.stroke_width)
            elif isinstance(f, ImageMobject):
                self.array(f.points)
                self.put(hashlib.sha256(f.pixel_array.tobytes()).digest(), f.fill_opacity)
            if isinstance(f, Text):
                self.put(f.original_text)
            ours = type(f).__module__.startswith("catchup_video")
            for k, v in sorted(vars(f).items()):
                if (ours or k.startswith("_cv_")) and _scalar(v) and k not in _VOLATILE:
                    self.put(k, v)
                elif k == "_cv_full":
                    self.put(k)
                    self.mob(v)

    def value(self, v, depth: int = 0) -> None:
        if isinstance(v, Mobject):
            self.mob(v)
        elif _scalar(v):
            self.put(v)
        elif isinstance(v, np.ndarray):
            self.array(v)
        elif depth > 3:
            self.put(type(v).__name__)
        elif isinstance(v, (list, tuple)):
            self.put(len(v))
            for x in v:
                self.value(x, depth + 1)
        elif isinstance(v, dict):
            for k in sorted(v, key=repr):
                self.put(k)
                self.value(v[k], depth + 1)
        elif hasattr(v, "__dict__"):
            self.put(type(v).__name__)
            for k, x in sorted(vars(v).items()):
                self.put(k)
                self.value(x, depth + 1)
        else:
            self.put(type(v).__name__)


def stage(scene, story_attrs: list[str]) -> str:
    """Everything on stage and held by the story's own attributes, as one hash."""
    h = _Hasher()
    frame = scene.camera.frame
    h.array([*frame.get_center(), frame.width])
    for m in scene.mobjects:
        if m is not frame:
            h.mob(m)
    for name in story_attrs:
        h.put(name)
        h.value(getattr(scene, name))
    return h.h.hexdigest()


@lru_cache(maxsize=8)
def _module_parts(path: str, beat_sources: tuple[str, ...]) -> tuple[str, str]:
    """The story's code outside its beats, and the hash of every image it names."""
    source = Path(path).read_text()
    rest = source
    for s in beat_sources:
        rest = rest.replace(s, "")
    return rest, json.dumps(_assets(rest, Path(path).parent))


def _assets(code: str, root: Path) -> list[tuple[str, str]]:
    out = []
    for name in sorted(set(_ASSET.findall(code))):
        f = root / name
        if f.is_file():
            out.append((name, hashlib.sha256(f.read_bytes()).hexdigest()))
    return out


def beat_key(*, fn, beat_fns, story_path: str, quality: str, timing: dict, state: str) -> str:
    """The cache key of one beat's render."""
    sources = tuple(inspect.getsource(f) for f in beat_fns)
    rest, rest_assets = _module_parts(story_path, sources)
    own = inspect.getsource(fn)
    h = hashlib.sha256()
    for part in (toolkit(), quality, rest, rest_assets, own, json.dumps(_assets(own, Path(story_path).parent)),
                 json.dumps(timing, sort_keys=True), state):
        h.update(part.encode())
        h.update(b"\0")
    return h.hexdigest()[:40]
