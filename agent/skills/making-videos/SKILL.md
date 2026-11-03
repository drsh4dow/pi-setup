---
name: making-videos
description: "Narrated videos end to end: brief, script, voice, capture of a web, Android or iOS app, composed motion graphics, cut, mix, and checks on the exported file. Use when the user asks for a video, walkthrough, demo, tutorial, promo, or recorded proof of a change."
---

# Making videos

A video here is a script voiced first, a picture cued to that voice, one cut, and checks on the file the viewer will watch. Pick the blocks the video needs. The user's rules and the checks on the export apply to every video.

## The user's rules

Each rule cost the user at least one round of rework. They outrank every brief, including one you wrote.

- **Real product, real data.** "I care more about the real product proof rather than the quality of the video itself." Record the real thing doing the work. Every fact the video states or draws traces to a file, a run, or a receipt in `CLAIMS.md`. Label what is staged or drawn. Use synthetic records only where a real one would expose a person.
- **The whole screen at one scale.** "the browser view should be complete, the full browser, not a zoom in that looks like shit." A web app is the full browser window, tabs and address bar included, at 1:1. A phone is its whole screen with the status and navigation bars, at one scale for the whole video. Words go outside the picture or in a subtitle track.
- **Voice first, live at 1.0×.** "also the pacing is awful." Voice the script, then drive or animate to the words, so each action lands as its line names it. The one edit to time is a jump cut over a real wait, with the measured time said or shown ("about 40 s later").
- **No weird pauses.** Quiet gaps of 0.12 to 0.5 s between lines and under 0.6 s inside one. Something on screen moves at least every 2 s. Speech runs about 150 to 175 words a minute. In a captions-only video, a caption stays up at least 1.5 s plus 0.3 s per word; a narrated caption lasts as long as its words.
- **Clear for this audience.** Name who watches, what they already know, and where it plays. For first-time viewers, say where each control is before using it, define each term in their words, and hold each new screen long enough to read before acting on it. Say what happens behind the screen, not only where to tap.
- **Looks are judged by eyes.** A structural checklist passed a video the user called "aesthetically a total failure". Show the user one finished chapter in its final framing before the full cut. Offer the look and the voice as separate picks, the voice as two or three rendered samples to hear.
- **A separate watcher before "ready".** "a subagent must also watch it before claim is ready to correct anything". A false or unshown claim blocks the cut. Polish never does, and the user's approval of a cut ends polishing.
- **One clear file, opened.** "where are the final videos? open its folder with xdg-open". See Handoff.

## Steps

Copy these into your todo list. Each ends on its done-when.

1. **Brief.** Write `BRIEF.md` in `~/Videos/<project>/src/`: the audience and what they know, where it plays, the one sentence they leave with, length, kind, truth sources, the identities allowed on screen, and the voice. Done when you have checked it against each rule above and nothing in it contradicts one.
2. **Script.** Write `script.json` and `CLAIMS.md` per [references/story.md](references/story.md). Done when every line has its source in `CLAIMS.md`.
3. **Voice.** `scripts/narrate.py script.json` writes `narration.wav` and `voice.json`, the clock every later block reads. Render a chapter in two or three voices with `--voices` for the user to hear. The default is Gemini's Iapetus, then ElevenLabs' Mark, then captions only; say which one ran. When `narrate.py` prints more than 175 words a minute while speaking, slow the voice at the provider (`eleven:Mark@0.8` is the floor, or Gemini's `--style`), never by stretching its audio. A voice at 0.7, stretched again so each caption held 1.5 s, sounded to the user "like it is talking 0.5x"; that hold is for captions-only videos. Done when the user has picked the voice by ear (or you logged the default because the user said to run without stopping), and `narrate.py` reports a longest quiet gap of 0.5 s or less in that voice. A captions-only video runs `--voice captions` and has no voice to pick. Every take and scene is timed to this file, so a later voice change means new takes.
4. **Picture.** Read the reference for where the picture comes from:

   | Picture | Read |
   | --- | --- |
   | A web app in a browser | [references/capture-web.md](references/capture-web.md) |
   | An Android or iOS app | [references/capture-mobile.md](references/capture-mobile.md) |
   | Motion graphics, a promo, an explainer, a terminal tutorial | [references/compose.md](references/compose.md) |

   Done when you have looked at full-size frames of every take or scene yourself, and each logged click or tap lands on the frame where the UI reacts, measured on the take's clock.
5. **One chapter first.** Cut one chapter in its final framing, give the user its path, open it, and wait for a yes. If the user told you to run without stopping, log that you skipped the wait and show the chapter at handoff. Done on the user's yes or the logged skip.
6. **Cut and mix.** Per [references/cut-and-mix.md](references/cut-and-mix.md). Done when the export exists and you know its sha256.
7. **Check the export.** Run every check in [references/checks.md](references/checks.md) that applies to this video's profile. Done when each passes on the exported file.
8. **Watch.** Brief a fresh subagent from [references/watcher-brief.md](references/watcher-brief.md) for each new sha256. Fix its blockers and should-fixes, re-export, and send the new file to a new watcher. Stop at a ready verdict or after three rounds, and report what is left.
9. **Hand off.** Done when the user has the path and the file is open.

## Handoff

- Put the absolute path of the final file on its own line, with its length and size, then open it with `xdg-open`.
- Finals go in `~/Videos/<project>/`, sources in `~/Videos/<project>/src/`. A disk cleanup once wiped every source of a video kept under `/tmp`.
- Write `README.md` beside the final: path and sha256, length, chapters, how it was made (what is real, staged or masked), known gaps, the watcher verdict with its sha256, and "human listening pass: not measured".
- Delete superseded cuts or mark them in the README. Give the user videos only, never an intermediate file such as a script or a timeline.
- For a PR or ticket, upload the file (the **dumpfile** skill, or the tracker's own upload), download it again, compare sha256, and link the URL.

## Machine

- Run one render or recording at a time, in the background. Video work has run this machine out of memory.
- Stop every recorder, browser and emulator you start in a `finally`, and leave shared ones alone.
- Before helpers start from a brief, run each command in it once. A wrong render flag in one brief made three helpers render the whole film.

## Scripts

All in `scripts/`. Each prints `--help`, takes parameters, and has a self-test; `scripts/self-test` runs them all. Run each as an executable so its `uv run --script` shebang installs what it declares. They need ffmpeg, uv, jq, Node 22+ and Chromium; web capture also needs Xvfb, xdotool and agent-browser.

| Script | Block |
| --- | --- |
| `narrate.py`, `tts.py` | voice: lines to `narration.wav` and `voice.json`, cached per line |
| `window.py`, `drive.py`, `cdp.mjs`, `mask.js` | web capture: full window on Xvfb, human input, events log, privacy mask |
| `cut.py` | cut takes from `EDIT.json`: one scale, rings, outlines, captions, chips, voice |
| `mix.sh`, `music.sh` | voice plus an optional music bed, ducked, to -16 LUFS |
| `check.sh`, `sync.py`, `framing.py`, `overlays.py`, `framediff.py` | checks on the export |
| `frames.py` | frames by index for your eyes and the watcher's |

`templates/remotion/` is the starter for composed films.
