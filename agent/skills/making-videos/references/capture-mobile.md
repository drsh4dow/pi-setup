# Capturing a phone or tablet app

The picture is the device's whole screen, status and navigation bars included, at one scale for the whole video. Taps show as rings drawn from logged events, moved onto the video clock as Taps below says. A project's `verify-mobile` skill, when it has one, says how to build, install and sign in: read it first.

## Android (proven)

- **Your own emulator.** Another session may be driving the shared one: check `adb devices` and the emulator's start time. Make a private AVD (for example `system-images;android-35;google_apis;x86_64`, `-d pixel_7`, `hw.keyboard=no` so the soft keyboard shows), run it on its own port, and target it with `-s emulator-<port>`. Delete it after handoff and report the disk it freed as measured.
- **Recording.** One Maestro flow per take, recorded with `adb shell 'date +%s.%N; exec screenrecord --bit-rate 24000000 --time-limit 180 /sdcard/take.mp4'`, stopped with `pkill -INT screenrecord`, then pulled and converted to 30 fps CFR. Reading the device clock in the same shell call starts the video clock.
- **Taps.** Read Maestro's `Tapping at (x, y)` debug lines and their times. Match both of its log formats (`onCommandStart` and `runCommands$lambda$N`). Move them onto the video clock with the device-minus-host offset (the median of 3 measurements; one device ran 0.617 s behind). Then compare a late tap's ring with the frame where the UI reacts and shift for drift (0.4 s over 2 minutes once), keeping the logged time as `t_logged`.
- **Rings on the real tap.** Write the taps as `takes/<take>.events.json`: `{"width", "height", "fps", "events": [{"t", "kind": "click", "x", "y", "label", "t_logged"}]}` in device pixels, so `cut.py` draws each ring at the tap's frame. The take fires the tap on the word that names it, so ring and word coincide.
- **Behind the screen.** Say what each screen does underneath, from the code, with `path:line` in `CLAIMS.md`.

Footguns:

- screenrecord stops at 180 s. Keep each flow under 3 minutes and split at a natural break.
- Maestro rejects percentage taps. Use whole pixels.
- WebView text is missing from Maestro's hierarchy. Drive it with swipes and point taps, and read screenshots: a Maestro check can pass on a blank screen.
- The soft keyboard hides buttons. Dismiss it first, and say so in the voice.
- A second app left on top took typed input. Force-stop it before each take.
- Set `show_password 0` so typed passwords never show. Scrub credentials from every file a take keeps.
- Some fields garble fast input. Type 0.25 to 0.35 s per character where it must look human.
- Takes write real data. Pick unused records, log them as receipts, and re-read shared logs before writing.
- When the device's timezone or date differs from the app's, say it on screen.

## iOS (from Apple's docs, untested here)

Needs a Mac with Xcode. On another host, say so in the plan and ask for one rather than faking an iPhone.

- Boot a simulator of your own (`xcrun simctl create`, `boot`), and delete it after handoff.
- `xcrun simctl status_bar booted override --time 9:41 --batteryLevel 100` gives a clean, stable status bar. Say on screen that it is overridden.
- Record with `xcrun simctl io booted recordVideo --codec h264 --mask black take.mov`, stopped with SIGINT. It has no time limit and keeps the whole screen with its corners.
- Drive with Maestro, which also supports iOS simulators, and draw rings from its log as on Android. Some iOS options had to be tapped by measured position.
