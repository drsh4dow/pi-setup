"""Problems a primitive finds while it lays itself out, such as words that cannot fit their room
at the minimum size. The running Video reports each against the beat that made it."""

from __future__ import annotations

import sys

_sinks: list = []


def problem(message: str) -> None:
    """Report `message` as a problem of the beat being rendered."""
    if _sinks:
        _sinks[-1](message)
    else:
        print(f"catchup_video: {message}", file=sys.stderr)
