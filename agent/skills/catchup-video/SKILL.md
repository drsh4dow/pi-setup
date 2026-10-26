---
name: catchup-video
description: "Catch the user up like /skill:catchup, with a short narrated video of what happened and the waiting calls as text under it. Use for /skill:catchup-video."
disable-model-invocation: true
user-invokable: true
---

# Catchup video

Follow [`/skill:catchup`](../catchup/SKILL.md), but show what happened in a short narrated video instead of its summary and visuals. Its window starts at the last message the user wrote before `/skill:catchup-video`, not before any earlier `/skill:catchup`. Writing and rendering the video in the state folder, then opening it with `xdg-open`, is the one exception to its read-only rule. The reply is catchup's opening sentence, a link to the video file, one line naming any work left that you can do yourself, and the action items. When the video shows a call's options, call each option by the name the video gives it. If the video has no voice, say so in one line with the reason the check printed. If the render fails, say so in one line and give only the calls.

## The script

Use the screenshots, recordings, diffs, and data the work produced, not the chat's prose about them. Before you write, name the one sentence the user should leave with. Then write the narration as beats, one idea each, in the words a person would say aloud: short sentences, numbers as they are spoken. Open with what waits on the user, give each thing they asked for a chapter, and close with every call in the reply, in its order. Calls of one kind, such as PRs that only need a merge, can share one beat that names them as a group while the picture marks each one. The whole video stays under two minutes; drop each beat that does not change what the user knows.

Say what came of each thing the user asked for, and whether it is done, still running, failed, or not checked. Never call something done that still waits on the user. Say any bug found and fixed on the way. When something you told the user earlier turned out wrong, say what you said and what is true. Give each call only the options the work weighed or the chat raised, each with what it gains and costs, and your pick. Never invent a number, and never draw a screen you did not capture; when a visible change has no screenshot, say so.

## The picture

Put one picture on stage first and change it for the rest of the video rather than cut to unrelated ones. For PRs that is the branch graph: dive into a PR for its chapter, where the graph stays on screen as a strip at the left that highlights the PR and shows each mark as the chapter earns it, and pull back at the end. Give every beat something new to show. Put a choice or a detail in a chapter, beside the strip, rather than over a dimmed graph. Show the work itself: the code change animating in place, the arithmetic of a bug becoming the arithmetic of its fix, a number ticking to its new value, a real screenshot with what changed outlined, data as bars or tiles, options side by side with the pick outlined. A color means the same thing for the whole video. A picture is never a bullet list, a status list, a table, or boxes with nothing connecting them.

The narration carries the words, so keep text on screen to labels on the things they name and the numbers that matter. Never write on screen what the voice is saying, apart from the captions.

## Render

The toolkit is `node <skill dir>/scripts/video.ts`. Run `video.ts --help` and `video.ts primitives` first, and follow the one-shot order `--help` gives: write the narration file, run `video.ts new STORY.py --from` it in the state folder, fill every beat in one pass with the pieces `primitives` lists, draft once, read every problem and look at every frame sheet, fix, then `video.ts render`. The toolkit fits pieces and motion to the stage, so a layout or timing problem means the request does not fit: cut words or motion instead of moving things by hand. A draft or render after a fix redraws only the beats it touched. Fix any beat where something is hard to read, overlaps, sits idle while the voice moves on, or shows something the voice does not say, even when the check is clean. Open the video only when the check exits 0.
