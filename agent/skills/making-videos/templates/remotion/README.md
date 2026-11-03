# Remotion film starter

Copy this folder, copy `narrate.py`'s `voice.json` and `narration.wav` into `public/`, and replace `src/chapters/Example.tsx` with one component per chapter. Mount each in `src/Root.tsx` inside a `SceneWindow` whose `id` is its chapter id in `voice.json`. Mount recorded footage in `<SceneWindow footage>`, which holds it at one scale; drawn graphics get a slow push-in.

Remotion is free only for individuals and companies of up to 3 people. For a larger company, tell the user it needs a paid license before you build on it.

```bash
bun install                                                          # copy node_modules/.remotion/chrome-headless-shell from another Remotion project if Chrome's download is slow
npx remotion studio                                                  # preview with the voice
npx remotion render Film out/check.mp4 --frames=120-240 --scale=0.5  # a chapter or motion check
npx remotion bundle src/index.ts --out-dir=out/bundle                # bundle once, then any number of stills
npx remotion still out/bundle Film out/f140.png --frame=140
npx remotion render Film out/film.mp4                                # full 1080p film
<skill dir>/scripts/mix.sh out/film.mp4 public/narration.wav out/final.mp4   # voice to -16 LUFS, plus optional --music bed
npx tsc --noEmit                                                     # type check; never pipe it, `tsc | head` exits 0 over type errors
```

- The range flag is `--frames=A-B`. `--frame-range` is ignored and renders the whole film; that wrong flag, copied into three helpers' briefs, overloaded the machine.
- Render one thing at a time. Concurrency is 2 in `remotion.config.ts` because renders share the machine.
- Every render carries `public/narration.wav` under its frames, so a chapter clip plays its own lines. `mix.sh` replaces that audio in the full film.
- Captions are on by default; pass `--props='{"captions":false}'` to drop them.
- Load fonts only through `useFonts()` in the root component, and keep them as small woff2 subsets (`uvx --from 'fonttools[woff]' pyftsubset … --flavor=woff2`). Fonts loaded at module scope, or a multi-megabyte font, hung renders while stills worked fine.
