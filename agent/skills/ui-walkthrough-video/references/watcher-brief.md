# Watcher brief

Fill the brackets and hand this to a separate subagent. The watcher reviews one export; a new export needs a new watch.

```text
KIND: watcher. Review one walkthrough export for product truth and privacy. Do not edit the video or the takes.

Export: [absolute path], sha256 [hash]. Timeline: [timeline.json]. Transcript: [transcript.md].
Receipts and take provenance: [the takes' events.json files, receipt files].
What the video must prove: [the claims, one per line, each with the receipt that backs it].
Audience: [internal | external]. Identities allowed on screen: [for example: synthetic clients only; the operator masked].

1. Run the checks on this export and read their reports: check.sh, framing.py, overlays.py, sync.py from
   [skill dir]/scripts. Quote each verdict line. A FAIL is a finding.
2. Look at frames, chosen by index with frames.py: every chapter cut, every caption change near a jump cut or a
   tab switch, the frame where each narrated action triggers, and the frames where each result appears.
   Check redaction on full-resolution frames (frames.py --at), starting at 0:00.
3. For every narrated claim, find the frame that shows it and the receipt that backs it. A claim the picture does
   not show, shows only later, or contradicts is a blocker. So is a control the voice says worked that did not.
4. Report on-screen UI noise (stray hints, clipped text, odd states) as product feedback, apart from the video.

Stop at the first frame that shows [the data classes that may never appear, such as client or member data]:
report its time and what it shows, and review nothing further. Other identities go in the findings as nits.

Rank each finding: blocker (a false or unshown claim, a privacy break, a failed check), should-fix (a claim shown
but hard to follow), nit (polish: timing, wording, layout). Write findings.md naming the export's sha256, with
each finding's time, frame number, what is wrong, and the evidence. End with: ready or not ready for this sha256.
```

Ranking rules for whoever acts on the findings:

- Fix blockers before anyone calls the cut ready. Polish never blocks.
- Once the user approves a cut, stop polishing it.
- When the user asked for an independent watcher, a cut is ready only with a watcher verdict on its sha256. The user is not the fallback reviewer.
