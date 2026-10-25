"""Entry points scripts/video.ts calls: beats, render, reference."""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import os
import sys
from pathlib import Path


def load_story(path: Path):
    from .clock import Video

    sys.path.insert(0, str(path.parent))
    sys.dont_write_bytecode = True  # no __pycache__ next to the story
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    found = [v for v in vars(mod).values() if isinstance(v, type) and issubclass(v, Video) and v is not Video]
    if len(found) != 1:
        raise SystemExit(f"{path}: define exactly one Video subclass, found {len(found)}")
    return found[0]


def beats(path: Path) -> None:
    from .clock import beats_of

    story = load_story(path)
    print(json.dumps({"voice": story.voice, "beats": [fn._cv_beat for fn in beats_of(story)]}))


def render(path: Path, quality: str, out: Path) -> None:
    from manim import config, tempconfig

    width, height, fps = (854, 480, 15) if quality == "draft" else (1920, 1080, 60)
    os.environ["CATCHUP_STORY_DIR"] = str(path.parent.resolve())
    story = load_story(path)
    settings = {"pixel_width": width, "pixel_height": height, "frame_rate": fps, "media_dir": str(out),
                "disable_caching": True, "progress_bar": "none", "verbosity": "WARNING",
                "output_file": "chunk", "write_to_movie": True}
    with tempconfig(settings):
        config.background_color = "#0F1218"
        scene = story()
        scene.render()
        print(json.dumps({"video": str(scene.renderer.file_writer.movie_file_path)}))


def _sig(obj, skip_self: bool) -> str:
    from . import theme as T

    import numpy as np
    from manim import DOWN, LEFT, ORIGIN, RIGHT, UP

    names = {v: f"T.{k}" for k, v in vars(T).items() if k.isupper() and isinstance(v, (str, int, float))}
    directions = {"ORIGIN": ORIGIN, "UP": UP, "DOWN": DOWN, "LEFT": LEFT, "RIGHT": RIGHT}
    params = list(inspect.signature(obj).parameters.values())
    if skip_self and params and params[0].name == "self":
        params = params[1:]
    parts = []
    for p in params:
        if p.default is inspect.Parameter.empty:
            parts.append(("*" if p.kind is p.VAR_POSITIONAL else "") + p.name)
        else:
            d = p.default
            if isinstance(d, np.ndarray):
                shown = next((k for k, v in directions.items() if np.array_equal(v, d)), repr(d.tolist()))
            elif isinstance(d, (bool, type(None))):
                shown = repr(d)
            else:
                shown = names.get(d, repr(d))
            parts.append(f"{p.name}={shown}")
    return "(" + ", ".join(parts) + ")"


def _doc(obj) -> str:
    return " ".join((inspect.getdoc(obj) or "").split("\n\n")[0].split())


def reference() -> None:
    from . import PRIMITIVES, theme as T
    from .clock import Video, beat

    out = ["Primitives (from catchup_video import *):", ""]
    for p in PRIMITIVES:
        out.append(f"{p.__name__}{_sig(p, inspect.isclass(p))}  # {_doc(p)}")
        if inspect.isclass(p):
            for k, v in vars(p).items():
                if not k.startswith("_") and inspect.isfunction(v):
                    out.append(f"    .{k}{_sig(v, True)}  # {_doc(v)}")
    out += ["", "The story (class Story(Video), one method per beat):", "",
            f"@beat{_sig(beat, False)}  # {_doc(beat)}"]
    for k in ("at", "hold", "show", "hide", "clear", "pin", "dive", "pull_back"):
        v = getattr(Video, k)
        out.append(f"self.{k}{_sig(v, True)}  # {_doc(v)}")
    out += ["self.header  # the pinned chapter header after dive(), else None",
            "self.play(...), self.add(...), self.camera.frame  # plain Manim works too; every Manim name is imported", "",
            "Theme (T.*): colors keep one meaning for the whole video:",
            f"  T.BLUE {T.BLUE} facts and data, T.YELLOW {T.YELLOW} waiting on the viewer, "
            f"T.RED {T.RED} problem or cost, T.GREEN {T.GREEN} fixed or passing,",
            f"  T.TEXT {T.TEXT} words, T.DIM {T.DIM} none or not yet, T.FAINT, T.PANEL, T.BG.",
            f"  Fonts: T.SANS ({T.SANS}) labels, T.SERIF ({T.SERIF}) numbers and math, T.MONO ({T.MONO}) code.",
            f"  Sizes (em px at 1080p): T.LABEL {T.LABEL}, T.SMALL {T.SMALL}, T.CODE {T.CODE}, "
            f"T.NUMBER {T.NUMBER}, T.HEADER {T.HEADER}.",
            f"  Stage (Manim units): x {T.LEFT}..{T.RIGHT}, y {T.FLOOR}..{T.TOP} below the header row; "
            "captions own the band under T.FLOOR."]
    print("\n".join(out))


def main() -> None:
    ap = argparse.ArgumentParser(prog="catchup_video")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("beats").add_argument("story", type=Path)
    r = sub.add_parser("render")
    r.add_argument("story", type=Path)
    r.add_argument("--quality", choices=["draft", "final"], required=True)
    r.add_argument("--out", type=Path, required=True)
    sub.add_parser("reference")
    a = ap.parse_args()
    if a.cmd == "beats":
        beats(a.story)
    elif a.cmd == "render":
        render(a.story, a.quality, a.out)
    else:
        reference()


if __name__ == "__main__":
    main()
