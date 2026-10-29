---
name: ui-walkthrough-video
description: "Building blocks for a recorded UI walkthrough: drive a live web app like a real user in an agent-owned browser, record it, cut it with optional narration, and check the export before calling it ready. Use when the user asks for a recorded UI walkthrough, a demo video of UI work, or video proof of a UI change. Not a recap of past work."
disable-model-invocation: false
user-invokable: true
---

# UI walkthrough video

A recorded UI walkthrough shows the real product doing the thing, driven the way a person would use it. The catchup-video skill is different: it draws schematics from artifacts, while this skill records a live UI.

These are blocks, not a pipeline. Pick the ones the video needs, in the order that suits it, and design the layout for the video in front of you. [references/example-layout.md](references/example-layout.md) shows one session's layout, as an example only. Two parts are fixed whatever you build: the user's rules below, and the checks on the export.

## The user's rules

These came from the user's complaints. Each rule cost a round of rework the first time.

- **Real use, good pacing, a separate watcher.** "I want good pacing, not pauses in between, I want real user behavior, and I want a pleasant visualization of the real thing, a subagent must also watch it before claim is ready to correct anything, viusal verification in UI work is paramount". So: a visible pointer, human typing and wheel scrolling, and no dead air (no span over 1.0 s that is both frozen and silent). Backend waits become jump cuts.
- **The whole page, always.** "ok I hate it, it should display the full page, like wtf, Why would it shows the zoom in thing? that is not clear". The page shows each take's whole viewport at one fixed scale and place. Never zoom, pan or crop it. Captions and labels sit outside the page.
- **Proof over polish.** "do not worry about it, I care more about the real product proof rather than the quality of the video itself." Then: "I love the video, what are the issues that are blocking you?" A false or unshown claim blocks the cut. Polish never does, and the user's approval of a cut ends polishing.
- **One clear file.** "give me the full path of the video", then "what is the difference? which one is the newest and best?" See Handoff.

A project can add its own recording rules, such as which accounts, environments and fixtures a take may touch. Look for a recording section in the project's skills before the first take.

## Before capture: audience and privacy

- Name the audience (internal or external) and the identity classes allowed on screen before the first take. Examples: synthetic test clients only; staff names allowed internally; the operator's own account masked.
- Mask before recording, never after. [`scripts/mask.js`](scripts/mask.js) covers emails and any terms in `window.__uiwMaskTerms` and redraws every 80 ms. It cannot recognise names, so list them as terms or keep them off screen.
- Check redaction on full-resolution frames of the export (`frames.py --at`), starting at 0:00. A watcher once stopped at 0:00 on a staff email that the contact sheets had missed.
- Transcription stays local (`sync.py` runs faster-whisper on the machine). Only narration you would publish goes to external TTS. Logs hold coordinates, labels, lengths and IDs, never typed text.

## Recording

- **The browser.** Use an agent-owned Chromium: a headless `agent-browser --session NAME`, or the shared agent browser when the project defines one. Never use the user's daily browser.
- **One take per beat.** Each take is one mp4 of one tab at a fixed viewport, plus an `events.json` on the same clock. The recorder follows the active tab, so a second tab gets its own take. Set the viewport and inject the mask before `record start`. Any change to either needs a new take.
- **The driver.** [`scripts/drive.py`](scripts/drive.py) is an importable `Take` class. It gives eased pointer moves, per-character typing, real wheel scrolls at the pointer, and DOM-box `mark`s an edit can outline later. Its `wait_until` is logged so the edit can jump-cut the wait. Use `with take:` so a failing step still stops the recorder and keeps the log. Without it, a crash left the recorder running and the mp4 had no index.
- **Preflight.** `drive.py preflight --session S --out DIR` records 2 s of pointer motion. It fails when the window is not painting.
- **Raw CDP.** [`scripts/cdp.mjs`](scripts/cdp.mjs):
  - `wheel` scrolls at the pointer. agent-browser's `mouse wheel` fires at 0,0.
  - `new-window` replaces a minimised window, which paints nothing. `mouse move` times out and the take is blank, and restoring the window does not help.
  - Get the endpoint from `/json/version`. A browser started with `--remote-debugging-port` may write no `DevToolsActivePort`.
- **Take provenance.** Log each take's starting state (IDs, counts), the writes it made, and the receipts it owns (`take.state`, `take.wrote`). When the cut goes back to older footage, say so inside the video (for example a "Recorded earlier" label). Once a cut replayed older footage and made a saved edit look lost. Prefer a recut or fresh read-only footage to reseeding fixtures just for the video, because reseeding has real side effects. Keep deploys and flag flips out of the recording window: one rolled the API mid-take.

## Cutting

- **[`scripts/cut.py`](scripts/cut.py)** builds the video from an `EDIT.json`. Its `--help` documents the file:
  - It places every take's whole viewport in one slot at one scale.
  - Click rings come from logged clicks, and outlines from logged marks or literal boxes.
  - Captions, labels and "N s later" chips are drawn only outside the slot.
  - Narration is optional, and the audio is normalised to -16 LUFS.
  - It writes `timeline.json` and `transcript.md`. `--still T` renders one composed frame for a layout review.
  - It exits 2 when an edit breaks a rule.
- **Your own cutter.** Have it write the same `timeline.json` (contract in [`scripts/_media.py`](scripts/_media.py)) and every check still runs.
- **Pacing.** Anchor each line to the take second it describes. Hold or speed up the picture (up to about 1.5×) so the voice and the action stay together, and leave typing on screen long enough to read. Measure the quiet gaps on the export.
- **Voice (optional).** [`scripts/tts.py`](scripts/tts.py) calls ElevenLabs with timestamps and caches each line by hash. It reads the voice and model from [catchup-video's `narration.ts`](../catchup-video/scripts/narration.ts), so the two skills never drift. `ELEVENLABS_VOICE_ID` overrides the voice. A rebuild with `--offline` cannot re-voice by accident. With no voice, give each line a `dur` and the video is captions only.

## What may be drawn over the page

This is the complete allowlist: click rings and outline-only highlight boxes. Nothing else goes over the page: no cards, labels, arrows, blur, dimming or tinted fills, even over empty areas. Words go in the bands outside the slot.

Prose overlay rules leaked one word per round ("brief cards over empty areas", a blurred close, "translucent" outlines read as tinted). That took 8 watch passes and 7 fix passes. [`scripts/overlays.py`](scripts/overlays.py) enforces the allowlist against the export. On every run it also proves it would catch an opaque card and a faint fill. Keep the outline colours to one meaning each across the video.

## Before the full cut

Before you cut the whole video or start any watcher loop, show the user one finished chapter in its final framing and wait for a yes. A `--still` frame plus a short clip is enough. Watchers check the brief, not the user's taste. A zoom design the brief asked for passed two watch passes and two fix passes before the user rejected it, 4.5 hours in.

## Checks on the exported mp4

Measure the file the user will watch, never the edit plan. Captions once "passed" against the plan while the export lagged, and a frame-rate filter scored the wrong frames. Every script picks frames by index.

| Check | Script | Fails on |
| --- | --- | --- |
| Dead air, loudness, quiet gaps, contact sheets | `check.sh VIDEO --timeline T` | a span over 1.0 s both frozen and silent; a quiet span over 0.5 s between lines or 0.6 s inside one |
| Whole viewport, one scale | `framing.py T` | any sampled frame that a 1.1× zoom or an 8 px shift matches better; takes at different scales |
| Overlay allowlist | `overlays.py T` | a foreign tile outside the marks; a tinted outline interior; a self-test the detector misses |
| Caption sync | `HF_HUB_OFFLINE=1 sync.py T` | a caption's first frame more than 0.3 s from its first spoken word; a caption that never shows |
| Frames for eyes | `frames.py VIDEO --at/--around/--every` | nothing; it picks the frames you look at |

Then check by eye what no script covers:

- Each narrated claim against the visible action and state. Synced captions once narrated dates the UI had not selected yet.
- Redaction on full-resolution frames.
- Report the human listening pass as `not measured`. Speech recognition checks spelling, not how it sounds.

## Watcher

A separate subagent reviews each export before anyone calls it ready. Brief it from [references/watcher-brief.md](references/watcher-brief.md):

- A false or unshown narrated claim is a blocker; polish is a nit.
- The verdict names the export's sha256, and a new export needs a new watch.
- When the user asked for an independent watcher, never hand the cut to the user as its reviewer.

## Handoff

Give the user one absolute path to the current cut and open it for them. Then add a small manifest with one row per video:

- path and sha256
- duration and what it covers
- the cut it supersedes
- known gaps
- review status (the watcher verdict and its sha256)

Delete or clearly mark superseded files. Two of the files in one handoff were byte-identical.

## Scripts

Everything is in `scripts/`. Each script takes parameters (no hard-coded paths or sizes), prints usage with `--help`, and has a self-test on synthetic input. `scripts/self-test` runs them all. They need ffmpeg, uv, Node 22+ and Chromium (`$CHROMIUM`, default `chromium`).

| Script | Block |
| --- | --- |
| `drive.py` | human-paced driver, events log, take provenance, preflight |
| `cdp.mjs` | wheel at the pointer, fresh window, close, eval |
| `mask.js` | in-page privacy mask, injected before recording |
| `cut.py` | EDIT.json cutter: one slot, one scale, rings, outlines, captions, chips, optional voice |
| `tts.py` | ElevenLabs lines with timestamps, cached, catchup-video's voice |
| `check.sh` | dead air, quiet gaps, loudness, contact sheets |
| `framing.py` | no zoom, pan or crop |
| `overlays.py` | overlay allowlist, with can-fail self-tests |
| `sync.py` | caption first frame against local ASR speech onset |
| `frames.py` | frames by index: sheets, full-resolution stills, neighbours of a cut |
| `_media.py` | timeline contract, decoding by index, synthetic media |
