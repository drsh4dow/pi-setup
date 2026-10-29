# Example layout: one session's console walkthrough

This is the layout one walkthrough settled on after the user rejected zooms (a 4-minute cut the user said they loved). Copy from it or ignore it. Choose the canvas, slot, bands and pacing for the video you are making.

## Geometry

- Canvas 1920×1080 at 30 fps.
- Takes recorded in a headless agent-owned Chromium at a 1440×900 viewport.
- Page slot 1520×950 at the top, so the scale is 950/900. A 2 px border goes around the slot.
- A 1024 px-wide take (showing the responsive layout) sat in the same slot at the same scale, with the slot colour beside it.
- Caption band below the page, about 118 px tall.
- Left rail: chapter tag, PR pills, the synthetic client's code, and read-backs of stored values. Right rail: the "N s later" jump-cut chip.
- Outline colours kept one meaning across the video:
  - green: the latest item or the result
  - gray: an older item
  - blue: what the pointer acts on next
  - red: a refusal

The same layout as a `cut.py` edit:

```json
{"canvas": [1920, 1080], "fps": 30,
 "page": {"slot": [200, 8, 1520, 950]}, "frame": {"color": [100, 116, 139], "width": 2},
 "caption_box": [0, 962, 1920, 118], "caption_size": 34, "caption_rows": 2,
 "chip_box": [1730, 20, 180, 48],
 "labels": [{"box": [8, 20, 184, 120], "text": "Chapter title · PR tag", "t0": 0, "t1": 31}]}
```

## Pacing it met (from its report)

- Captions appeared 0.05 s before the first word and left 0.25 s after the last word, or earlier when the next caption came. 74 captions, worst offset +0.097 s.
- Quiet stretches were at most 0.399 s between lines (bar 0.45 s) and 0.597 s inside a line (bar 0.6 s). There was no dead air.
- Playback ran no faster than 1.5× (the fastest piece was 1.497×). Typing stayed on screen for at least 3 s at no more than 1.5×.
- Backend waits became jump cuts with the chip.
