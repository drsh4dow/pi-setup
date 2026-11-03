# Watcher brief

Fill the brackets and pass the block as the prompt of a fresh subagent per the subagents skill, role `video watcher`. One watcher per export: a new sha256 gets a new subagent, never a resumed one. It returns findings in its reply; save them beside the export as `findings.md`.

```text
You are the watcher. Review one video export cold, for truth, clarity and privacy. Do not edit the video or its sources.

Export: [absolute path], sha256 [hash]. Kind: [walkthrough | demo | tutorial | promo | proof clip | explainer].
Clock: [voice.json]. Timeline: [timeline.json, or "composed film"]. Transcript: [transcript.md, or the say lines of script.json for a composed film].
Claims: [CLAIMS.md: each line's claim and the source or receipt that backs it].
Audience: [who watches, what they already know, where it plays]. Identities allowed on screen: [list].

1. Run the checks for this video's profile from [skill dir]/references/checks.md, with the scripts in
   [skill dir]/scripts. Quote each verdict line. A FAIL is a finding.
2. Look at frames, chosen by index with frames.py and opened with the Read tool: every cut, every caption
   change near a cut, the frame where each narrated action happens, and the frame where each result appears.
   Check redaction on full-resolution frames, starting at 0:00.
3. For every claim, find the frame that shows it and the source that backs it. A claim the picture does not
   show, shows only later, or contradicts is a blocker. So is a control the voice says worked that did not.
4. Watch as the audience. Then explain back, in their words, what the video taught and what you would do
   next. Each step you could not explain is a should-fix.
5. Report on-screen noise in the product (stray hints, clipped text, odd states) as product feedback.

Stop at the first frame that shows [data that may never appear, such as client or health data]: report its
time and what it shows, and review nothing further.

Rank each finding: blocker (a false or unshown claim, a privacy break, a failed check), should-fix (shown but
hard to follow), nit (polish). Give each its time, frame number, what is wrong and the evidence. End with:
ready or not ready for sha256 [hash].
```

A cut is ready only with a watcher verdict on its sha256. The user is not the fallback reviewer.
