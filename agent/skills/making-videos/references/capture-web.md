# Capturing a web app

The picture is the whole browser window, tabs and address bar included, filling a 1920x1080 frame at 1:1, driven live by a visible pointer at human speed. A project may add its own recording rules, such as which accounts and environments a take may touch: look for a recording section in its skills before the first take.

## Setup

- `scripts/window.py` runs Xvfb and a headed Chromium on its own profile, records with ffmpeg x11grab, and drives with xdotool. It never captures the user's desktop and never uses their daily browser.
- For a video watched on a phone, start the window with `window.py up --scale 1.5` so its text reads there; for a laptop or a meeting-room screen keep the default 1. The scale grows everything in the window, tabs and address bar with the page, so the picture is still one window at one scale; never zoom the page alone.
- Sign the window in by copying the site's cookies from a signed-in agent browser (the **agent-browser** skill) over CDP.
- Prove a new setup with `window.py shot --display :99 --out check.png` and look at it: tabs, address bar and pointer are all there.
- Run `window.py --self-test` on a quiet machine. It proves the events clock matches the frames within 0.1 s. x264's lookahead once put every event 1.1 s ahead of its picture, so the recorder runs with `-tune zerolatency`.

## Privacy

- Name the identities allowed on screen in the brief. Inject `scripts/mask.js` before recording, never after. It covers emails and the terms in `window.__uiwMaskTerms`, re-runs on every DOM change, and must be injected again after each navigation. It cannot recognise names: list them as terms or keep them off screen.
- Check redaction on full-resolution frames of the export from 0:00. A watcher once stopped at 0:00 on a staff email the contact sheets had missed.
- Logs hold coordinates, labels, lengths and IDs, never typed text. Only narration you would publish goes to an external voice.

## Takes

- Drive each take with `WindowTake` from `scripts/window.py` (its `--help` shows the import). It records the whole X display and has `drive.py`'s `Take` methods: eased pointer moves, per-character typing, wheel scrolls at the pointer, DOM-box `mark`s for outlines, and a logged `wait_until` the cut can jump over. `drive.Take` alone records the page only. Use `with take:` so a failing step still stops the recorder. A crash once left the recorder running and the mp4 had no index.
- One take per chapter: one mp4 plus an `events.json` on the same clock, which starts at the take's first frame. A chapter's window starts halfway between the end of the chapter before it and its own start in `voice.json` (at 0 for the first chapter). Wait a lead of L seconds, then fire each action at L + (its word's `voice.json` time − the window's start) + the length of every earlier wait the shot jump-cuts. In `EDIT.json` the shot names its chapter and starts with `{"play": [L, ...]}`, and each jump cut skips exactly the logged wait. `cut.py` starts the shot at its window, so the take lines up in the full cut and in its chapter's preview alike.
- Log each take's starting state, the writes it made and the receipts it owns (`take.state`, `take.wrote`). Prefer read-only footage to reseeding fixtures for the video. Keep deploys and flag flips out of the recording window: one rolled the API mid-take.
- When a cut reuses older footage, say so in the video ("Recorded earlier"). A replayed take once made a saved edit look lost.
- Proof shows real state. When a step is stubbed, the voice or a caption says so.

## Footguns

- A minimised window paints nothing, and restoring it does not help. Open a fresh one (`cdp.mjs new-window`).
- X11 wheel steps are 120 px. `hscroll` sends sideways wheel buttons 6 and 7 for wide boards.
- A list or column that renders lazily showed skeletons for 1.5 s on camera. Scroll it into view and back once before recording.
- A native `<select>` snaps to its value with no menu on camera. Drive it with the keyboard or show the custom control.
- Close leftover modals, cookie banners and chat widgets (an Intercom iframe sits above the page) before recording.
- agent-browser has no add-init-script, so its mask goes in after each load. Its `mouse wheel` fires at 0,0: use `cdp.mjs wheel`.
- Get the CDP endpoint from `/json/version`. A browser started with `--remote-debugging-port` may write no `DevToolsActivePort`.
- `pgrep -f pattern` matches the shell running it. Write `pgrep -f "[p]attern"`.
