# Checks on the export

Measure the file the viewer will watch, never the edit plan. Captions once "passed" against the plan while the export lagged, and a frame-rate filter scored the wrong frames, so every script picks frames by index. Get frames for your own eyes with `frames.py` (`--at`, `--around`, `--every`) rather than your own ffmpeg command: ffmpeg 8 dropped `-vsync`.

## Scripts

Pass `--profile captions` to `check.sh` and `sync.py` for a captions-only video with no voice. The default is `narrated`. The limits are the user's rules, fixed in each script, and no flag loosens them. Each script's `--help` gives them.

| Check | Script | Fails on |
| --- | --- | --- |
| Dead air, quiet gaps, loudness, dark dips | `check.sh VIDEO --timeline T` | a span over 1.0 s both frozen and silent; quiet over 0.5 s between lines or 0.6 s inside one, measured on the timeline's voice track (or `--voice`) once it matches the export, so a music bed cannot hide a pause; loudness outside -16 ±1 LUFS or a true peak above -1 dBTP; in a composed film, a frame more than 25% darker than the frames around it. |
| Caption holds and sync | `HF_HUB_OFFLINE=1 sync.py T --video FINAL.mp4` | a caption more than 0.3 s from its first spoken word; a caption that never shows, or a subtitle cue with other words; fewer than 80% of captions measured; with captions only, a caption up for less than 1.5 s plus 0.3 s per word. Speech starts come from the timeline's voice track (or `--voice`), and a voice the export does not carry fails. |
| Whole picture, one scale | `framing.py T` | a frame that a 1.1× zoom or an 8 px shift matches better; takes at different scales |
| Overlay allowlist | `overlays.py T` | anything over the picture but rings and outlines; a self-test the detector misses |
| What changed between two exports | `framediff.py OLD NEW --allow T0-T1 [--allow T0-T1]` | a changed frame outside the spans you meant to change, by the worst 8x8 patch, so a small email still shows; two files at different frame rates |

`timeline.json` names the silent cut before `mix.sh`, so pass `--video FINAL.mp4` to `framing.py`, `overlays.py` and `sync.py` to measure the mixed export. `framing.py` and `overlays.py` apply to recorded takes.

The dark-dip check runs on composed films only, where a dip is a fade the film drew. A recorded cut reports it not applicable, because a real dialog backdrop dims the page. A composed film has no `timeline.json`: pass `--timeline public/voice.json` to `check.sh` (and `--area` to measure dips on the stage only), and give `sync.py` the same file with the export and the caption band: `sync.py public/voice.json --video out/final.mp4 --caption-box 0,930,1920,150`. Under a music bed, add `--voice public/voice.wav` to both.

## By eye

No script covers these, so look at full-size frames:

- Each claim against the frame that shows it. Synced captions once narrated dates the UI had not selected yet.
- Redaction from 0:00 on full-resolution frames, plus OCR of the film for `@`, `mail` and `.com` (tesseract `--psm 11` on frames upscaled 2× to grey).
- Text size and how long each screen stays readable for this audience.
- Read the whole transcript once. Reused narration once repeated a line.
- Report the human listening pass as "not measured" and ask the user for one listen. Speech recognition checks words, not how they sound.
