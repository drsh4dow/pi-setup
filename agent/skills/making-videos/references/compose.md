# Composed films

Promos, explainers and terminal tutorials drawn in code and cued to the voice. Copy `templates/remotion/` into `~/Videos/<project>/src/film/`. Its `README.md` has the commands to set it up, preview, render and type-check it, and the mistakes that broke renders before.

For a math-style explainer, the pi skill at `~/.pi/agent/skills/catchup-video` is a Manim toolkit. The user picked its look.

## Cue to the voice

- Cue every change on a spoken word with `at(line, word)` from `src/cues.ts`, never on a hand-typed frame. Words match the `say` text, so it is `at("d6", "three-sixty's")`.
- `at()` already lands 4 frames before the word, and `SceneWindow` cuts 9 frames before a chapter's first word. Add no offset of your own.
- Something moves at least every 2 s. Build on one picture through a chapter (things light up, connect, get checked) rather than cutting to unrelated pictures.

## Look

The user's favourite is 3Blue1Brown with code aesthetics. Offer the look as its own pick, with one still per option.

- A dark stage. One meaning per colour for the whole film, set in `src/theme.ts`.
- For a full-screen 1080p player: labels 26 px and up, file and terminal text 22 px and up, captions 36 px in a 150 px band. For a smaller player, such as a docs page, scale them by 1920 divided by its width, and keep a terminal to about 80 columns. Shared parts follow the same floor: a 17 px terminal title in a shared part was flagged by four watchers.
- Hold new text at least 1 s per 3 words, and keep command output up until the voice has covered it.
- Few words. Put each label on the thing it names, in the audience's words, never an internal enum name. Never repeat the narration as on-screen text. No bullet lists, no tables, no boxes with nothing connecting them.
- Eased entrances of 12 to 20 frames. No bouncing, spinning or flashing.
- Bright footage inside a dark design dissolves into the next picture. Start the incoming picture when the outgoing fade starts. A fade through the empty stage once dropped brightness from 165 to 14 for a quarter second, and it survived two polish rounds because nested parts had their own fades.

## Real footage and terminals

- Footage goes in as H.264 with no audio, scaled to the size it plays at, through `<OffthreadVideo muted>`. Pin each source's sha256.
- Mask on full-size frames before scaling, with an opaque box in the surrounding colour, never a blur. A real email once sat in every sidebar frame of a source clip. Prove every mask box is flat on every frame, and OCR the film.
- A terminal tutorial shows real output. Run each command, save its output, and type it through the `Terminal` part verbatim. Type commands at a human pace and hold each result long enough to read.

## Helpers

- When chapters go to helpers, give them one shared brief: how the film is built, the look, truth and privacy, how to check a chapter, and what to report. Each helper owns its chapter files only.
