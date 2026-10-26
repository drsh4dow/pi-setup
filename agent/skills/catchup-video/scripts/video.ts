#!/usr/bin/env node
/**
 * One command for narrated catchup videos: write a story, synthesize its narration, draft it,
 * render it, and check it. Run `node video.ts --help`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BAND_TOP, CAPTION, check, MIN_PX, type Probes, readBeat } from "./check.ts";
import { type Beat, cacheRoot, dig, narrate, parseTiming, stripTags, type Timing } from "./narration.ts";

const SKILL = dirname(dirname(fileURLToPath(import.meta.url)));
const PYTHON_DIR = join(SKILL, "python");
const FONTS = join(SKILL, "fonts");
const EXAMPLE = join(SKILL, "example", "story.py");

const HELP = `Narrated catchup videos in the 3Blue1Brown style, built on Manim.

  node video.ts primitives                       every piece, one line each, and a worked story
  node video.ts new STORY.py [--from SKELETON]   write a story with one empty method per beat
  node video.ts draft STORY.py [--beat NAME|N]   voice, 480p15 render, and check (seconds per beat)
  node video.ts render STORY.py                  voice, 1080p60 render, and the full check
  node video.ts check STORY.py [--draft]         check the last render again
  node video.ts narrate STORY.py                 synthesize the voice alone
  node video.ts setup                            install the render environment now

Options: --jobs N renders N chunks in parallel (default: all cores); --no-listen skips
transcribing the voice in the check.

One shot, in this order:
  1. Write the narration, one beat per line: what is spoken, and " || " plus the caption when it
     should differ ("fifty gifts || 50 gifts"). Run new STORY.py --from that file.
  2. Run primitives once, then fill every method in one pass. Put the one picture the video
     returns to on stage first (for PRs, a Branches graph): dive into a PR for its chapter,
     pull_back after it, recap the calls at the end. Prefer the pieces (Flow, Correction, Tally,
     Compare, Code.note) to hand-built groups; they fit themselves.
  3. Draft once. Read every problem line and look at every sheet in STORY.build/draft/frames.
  4. Fix what the check and the sheets show. The next draft or render redraws only the beats
     whose code, words, or starting picture changed; the rest come from the cache.
  5. Render once: it reuses the voice and draws every beat at 1080p60 in parallel. A fix after it
     redraws only the beats it touched. Share the video when the check is clean.

Layout is the toolkit's job: every piece fits itself to the stage (x -6.6..6.6, y down to
T.FLOOR, above the captions), wraps or shrinks its words but never below the minimums, and
anything brought on stage is kept inside it. Grid(n).put(piece, i) gives a piece its own cell;
self.beside(piece, target) puts it next to target where nothing else is. A layout problem in the
check means the request does not fit at the minimum size: cut words or give the piece more room.

Timing: each beat method starts when its words start (lead= starts it earlier); self.at("words")
waits for a phrase. The clock fits motion to the beat: an animation that would run past the beat's
end is sped up, up to twice its speed; past that the check names what to cut. Motion settles before
a beat's midpoint (the clock moves an animation that would cross it) unless the beat is
@beat(..., transition=True).

Voice: ElevenLabs eleven_v4 (ELEVENLABS_API_KEY), voice Mark, then Gemini TTS (GEMINI_API_KEY; the
story's voice = "...", default Iapetus), then captions only. A beat's words may carry v4 audio tags
for delivery, such as "[thoughtful]", "[curious]", "[sighs]", or "[short pause]": they shape the
ElevenLabs voice and never reach captions, cues, or checks. Every clip is cached in
~/.cache/catchup-video/tts and requested five at a time; a beat whose words did not change is never
synthesized again. The environment is installed there with uv on first run.

Sizes are em pixels at 1080p. Minimums: ${Object.entries(MIN_PX).map(([k, v]) => `${k} ${v}`).join(", ")}.
Captions are burned in at ${CAPTION.em} px below y = ${BAND_TOP} px (T.FLOOR in the story).

Output, next to STORY.py: STORY.mp4 (render) or STORY.draft.mp4, and STORY.build/<final|draft>/frames
with beat-NN-mid.png and beat-NN-end.png for every beat, plus sheet-N.png contact sheets (four beats
each, rows are beats, midpoint left and end right). Look at every sheet before you share the video.

The check reads Manim's own geometry at each beat's midpoint and end: elements that overlap, leave
the frame, enter the caption band, or have text below its minimum, and what a piece could not fit.
On a voiced render it also checks that each beat's voice starts with its captions, that caption
breaks fall in pauses, and that a transcript of the video's audio says each beat's words.
Exit codes: 0 clean, 1 problems (one line each, naming beat and element), 2 could not run.`;

/** The render could not run: a missing tool, a broken story, a failed process. Exit 2. */
class CouldNotRun extends Error {}

const log = (line: string) => process.stderr.write(`${line}\n`);
const env = process.env;

function sh(cmd: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", env: { ...env, ...extra }, maxBuffer: 1 << 28 });
}

// ---- environment -------------------------------------------------------------------

function python(): string {
  const lock = readFileSync(join(PYTHON_DIR, "uv.lock"));
  const venv = join(cacheRoot(env), `venv-${createHash("sha256").update(lock).digest("hex").slice(0, 12)}`);
  const stamp = join(venv, ".catchup-ok");
  if (!existsSync(stamp)) {
    if (sh("uv", ["--version"]).status !== 0) {
      throw new CouldNotRun("uv is not installed; install it (https://docs.astral.sh/uv/) and run again");
    }
    log(`installing the render environment into ${venv} (once)`);
    const r = spawnSync("uv", ["sync", "--frozen", "--no-install-project", "--project", PYTHON_DIR], {
      env: { ...env, UV_PROJECT_ENVIRONMENT: venv }, stdio: ["ignore", "inherit", "inherit"],
    });
    if (r.status !== 0) throw new CouldNotRun("uv sync failed; on Linux, Manim needs libcairo2-dev, libpango1.0-dev, and pkg-config");
    writeFileSync(stamp, "");
  }
  return join(venv, "bin", "python");
}

function py(args: string[], extra: Record<string, string> = {}): string {
  const r = sh(python(), ["-m", "catchup_video", ...args], { PYTHONPATH: PYTHON_DIR, ...extra });
  if (r.status !== 0) throw new CouldNotRun(`python ${args[0]} failed:\n${tail(r.stderr)}`);
  return r.stdout;
}

const tail = (text: string, n = 25) => text.trim().split("\n").slice(-n).join("\n");

/** Where each beat's render is kept, by the key of everything its frames depend on. */
const beatCache = () => env.CATCHUP_BEAT_CACHE ?? join(cacheRoot(env), "beats");

// ---- story -------------------------------------------------------------------------

type StoryBeat = Beat & { transition: boolean; lead: number };
type Story = { path: string; build: string; voice: string; beats: StoryBeat[] };

function loadStory(path: string | undefined): Story {
  if (!path) throw new CouldNotRun("name a story file: node video.ts <command> STORY.py");
  const abs = resolve(path);
  if (!existsSync(abs)) throw new CouldNotRun(`${abs} does not exist`);
  const data: unknown = JSON.parse(py(["beats", abs]));
  const raw = dig(data, "beats");
  if (!Array.isArray(raw) || raw.length === 0) throw new CouldNotRun(`${abs} has no @beat methods`);
  const beats = raw.map((b: unknown): StoryBeat => ({
    name: String(dig(b, "name")),
    say: String(dig(b, "say")),
    show: String(dig(b, "show")),
    pause: typeof dig(b, "pause") === "number" ? Number(dig(b, "pause")) : null,
    lead: Number(dig(b, "lead") ?? 0),
    transition: dig(b, "transition") === true,
  }));
  return { path: abs, build: abs.replace(/\.py$/, ".build"), voice: String(dig(data, "voice") ?? "Iapetus"), beats };
}

/** Names a beat method must not take: Video's own methods and Manim Scene's. */
const VIDEO_NAMES = new Set(["at", "hold", "show", "hide", "clear", "pin", "dive", "pull_back", "beside", "recap", "play",
  "add", "remove", "wait", "render", "setup", "construct", "header", "camera"]);

function skeleton(file: string, lines: string[]): void {
  const used = new Set<string>();
  const methods = lines.map((line) => {
    const [say = "", show] = line.split(" || ").map((s) => s.trim());
    let name = stripTags(say).text.toLowerCase().replace(/[^a-z0-9 ]+/g, "").split(/\s+/).filter(Boolean).slice(0, 4).join("_") || "beat";
    if (/^\d/.test(name)) name = `b_${name}`;
    if (VIDEO_NAMES.has(name)) name += "_beat";
    while (used.has(name)) name += "_";
    used.add(name);
    const args = [JSON.stringify(say), ...(show ? [`show=${JSON.stringify(show)}`] : [])].join(", ");
    return `    @beat(${args})\n    def ${name}(self):\n        pass  # what does the viewer see while these words play?\n`;
  });
  writeFileSync(file, `from catchup_video import *\n\n\nclass Story(Video):\n    voice = "Iapetus"\n\n${methods.join("\n")}`);
}

// ---- render ------------------------------------------------------------------------

type Mode = "draft" | "final";

function partition(slots: number[], jobs: number): [number, number][] {
  const total = slots.reduce((a, b) => a + b, 0);
  const out: [number, number][] = [];
  let start = 0;
  let acc = 0;
  for (const [i, s] of slots.entries()) {
    acc += s;
    const left = slots.length - i - 1;
    const want = jobs - out.length - 1;
    if ((acc >= total / jobs && want > 0) || left < want) {
      out.push([start + 1, i + 1]);
      start = i + 1;
      acc = 0;
    }
  }
  if (start < slots.length) out.push([start + 1, slots.length]);
  return out;
}

type ChunkBeat = { index: number; name: string; key: string; cached: boolean; start: number };

/** Render the beats in `range` that are not cached; every beat in it is then in the cache. */
function runChunk(story: Story, mode: Mode, dir: string, range: [number, number], timingFile: string, cache: string): Promise<ChunkBeat[]> {
  mkdirSync(dir, { recursive: true });
  return new Promise((done, fail) => {
    const child = spawn(python(), ["-m", "catchup_video", "render", story.path, "--quality", mode, "--out", dir], {
      env: { ...env, PYTHONPATH: PYTHON_DIR, CATCHUP_TIMING: timingFile, CATCHUP_BEATS: `${range[0]}-${range[1]}`,
        CATCHUP_BEAT_CACHE: cache },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => {
      const beats = dig(JSON.parse(out.trim().split("\n").at(-1) || "{}"), "beats");
      if (code === 0 && Array.isArray(beats)) {
        done(beats.map((b: unknown): ChunkBeat => ({
          index: Number(dig(b, "index")), name: String(dig(b, "name")), key: String(dig(b, "key")),
          cached: dig(b, "cached") === true, start: Number(dig(b, "start")),
        })));
      } else fail(new CouldNotRun(`rendering beats ${range[0]}-${range[1]} failed:\n${tail(err)}`));
    });
  });
}

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

function captions(timing: Timing, file: string, offset: number, beats: Set<string>): void {
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,Inter,${CAPTION.assSize},&H00EFE9E6,&H00EFE9E6,&H50180F0F,&H80180F0F,0,0,0,0,100,100,0,0,1,2.5,0,2,220,220,${CAPTION.marginV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const [k, b] of timing.beats.entries()) {
    if (!beats.has(b.name)) continue;
    const next = timing.beats[k + 1]?.start ?? timing.total;
    for (const [i, p] of b.phrases.entries()) {
      const last = i === b.phrases.length - 1;
      const end = last ? Math.min(p.end + 0.5, next - 0.1) : p.end;
      const words = p.text.replaceAll("{", "(").replaceAll("}", ")");
      // Phrases inside a beat abut, so they swap without a fade: a fade there would dim the
      // caption in a frame taken near the swap. A beat's captions fade in and out at its edges.
      const fade = `{\\fad(${i === 0 ? 120 : 0},${last ? 120 : 0})}`;
      lines.push(`Dialogue: 0,${assTime(p.start - offset)},${assTime(end - offset)},Cap,,0,0,0,,${fade}${words}`);
    }
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
}

type Rendered = { video: string; seconds: number; drawn: number; cached: number };

async function render(story: Story, mode: Mode, only: string | undefined, jobs: number): Promise<Rendered> {
  const t0 = performance.now();
  const dir = join(story.build, mode);
  const timing = await narrate({ beats: story.beats, outDir: join(story.build, "narration"), voice: story.voice, env,
    offline: false, log });
  mkdirSync(dir, { recursive: true });
  const timingFile = join(dir, "timing.json");
  writeFileSync(timingFile, JSON.stringify(timing, null, 2));
  let ranges: [number, number][];
  if (only) {
    const k = /^\d+$/.test(only) ? Number(only) : story.beats.findIndex((b) => b.name === only) + 1;
    if (k < 1 || k > story.beats.length) throw new CouldNotRun(`no beat ${only}; beats: ${story.beats.map((b) => b.name).join(", ")}`);
    ranges = [[k, k]];
  } else {
    const slots = timing.beats.map((b, i) => (timing.beats[i + 1]?.start ?? timing.total) - b.start);
    ranges = partition(slots, Math.max(1, Math.min(jobs, story.beats.length)));
  }
  const cache = beatCache();
  rmSync(join(dir, "chunks"), { recursive: true, force: true });
  const beats = (await Promise.all(ranges.map((r, i) => runChunk(story, mode, join(dir, "chunks", String(i)), r, timingFile, cache))))
    .flat().sort((a, b) => a.index - b.index);
  const fps = mode === "final" ? 60 : 15;
  const first = beats[0];
  const offset = first ? first.start / fps : 0;
  const names = new Set(beats.map((b) => b.name));
  const list = join(dir, "beats.txt");
  writeFileSync(list, beats.map((b) => `file '${join(cache, b.key, "beat.mp4")}'\n`).join(""));
  const ass = join(dir, "captions.ass");
  captions(timing, ass, offset, names);
  const stem = story.path.replace(/\.py$/, "");
  const out = mode === "final" ? `${stem}.mp4` : only ? `${stem}.draft-${only}.mp4` : `${stem}.draft.mp4`;
  const audio = timing.audio ? ["-ss", offset.toFixed(3), "-i", join(story.build, "narration", timing.audio)] : [];
  const r = sh("ffmpeg", ["-hide_banner", "-loglevel", "warning", "-y", "-f", "concat", "-safe", "0", "-i", list, ...audio,
    "-map", "0:v", ...(audio.length ? ["-map", "1:a", "-af", "apad", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-shortest"] : []),
    "-vf", `subtitles=${ass}:fontsdir=${FONTS}`, "-c:v", "libx264", "-preset", "veryfast",
    "-crf", mode === "final" ? "18" : "24", "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart", out]);
  if (r.status !== 0) throw new CouldNotRun(`ffmpeg could not finish the video:\n${tail(r.stderr)}`);
  if (/glyph.*not found|fontselect.*(fallback|not found)/i.test(r.stderr)) throw new CouldNotRun(`captions lost their font:\n${tail(r.stderr)}`);
  writeFileSync(join(dir, "render.json"), JSON.stringify({ video: out, offset, fps, beats }));
  const drawn = beats.filter((b) => !b.cached).length;
  return { video: out, seconds: (performance.now() - t0) / 1000, drawn, cached: beats.length - drawn };
}

/** The records of the last render's beats, read from the beat cache. */
function lastProbes(meta: unknown): Probes {
  const cache = beatCache();
  const beats = dig(meta, "beats");
  if (!Array.isArray(beats)) throw new CouldNotRun("the last render left no beats; render again");
  return {
    fps: Number(dig(meta, "fps")),
    beats: beats.map((b: unknown) => {
      const file = join(cache, String(dig(b, "key")), "beat.json");
      if (!existsSync(file)) throw new CouldNotRun(`${file} is gone from the cache; render again`);
      return readBeat(file, Number(dig(b, "index")), String(dig(b, "name")));
    }),
  };
}

async function report(story: Story, mode: Mode, listen: boolean): Promise<number> {
  const dir = join(story.build, mode);
  const meta: unknown = JSON.parse(readFileSync(join(dir, "render.json"), "utf8"));
  const timing = parseTiming(JSON.parse(readFileSync(join(dir, "timing.json"), "utf8")));
  const video = String(dig(meta, "video"));
  const result = await check({
    video, timing, probes: lastProbes(meta), framesDir: join(dir, "frames"),
    audio: mode === "final", listen, offset: Number(dig(meta, "offset") ?? 0), env,
  });
  console.log(`video: ${video}`);
  console.log(`frames: ${join(dir, "frames")} (${result.shots.length} frames; sheets ${result.sheets.map((s) => basename(s)).join(", ")})`);
  for (const s of result.skipped) console.log(`skipped ${s}`);
  for (const p of result.problems) console.log(p);
  console.log(result.problems.length ? `${result.problems.length} problem(s)` : "check: clean");
  return result.problems.length ? 1 : 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" }, beat: { type: "string" }, jobs: { type: "string" },
      from: { type: "string" }, "no-listen": { type: "boolean" }, draft: { type: "boolean" },
    },
  });
  const [command, file] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return 0;
  }
  const jobs = Number(values.jobs ?? availableParallelism());
  switch (command) {
    case "setup":
      console.log(python());
      return 0;
    case "primitives":
      console.log(py(["reference"]).trimEnd());
      console.log(`\nA worked story (${EXAMPLE}):\n`);
      console.log(readFileSync(EXAMPLE, "utf8"));
      return 0;
    case "new": {
      if (!file) throw new CouldNotRun("name the story file to write: node video.ts new STORY.py");
      if (existsSync(file)) throw new CouldNotRun(`${file} exists; pick another name`);
      const text = readFileSync(values.from ?? 0, "utf8");
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) throw new CouldNotRun("the skeleton has no beats: one line of narration per beat");
      skeleton(file, lines);
      console.log(`wrote ${file} with ${lines.length} beats`);
      return 0;
    }
    case "narrate": {
      const story = loadStory(file);
      const timing = await narrate({ beats: story.beats, outDir: join(story.build, "narration"), voice: story.voice, env, offline: false, log });
      console.log(`${timing.provider} ${timing.model ?? ""} ${timing.voice ?? ""}: ${timing.total.toFixed(1)}s, ${timing.beats.length} beats`);
      return 0;
    }
    case "draft":
    case "render": {
      const story = loadStory(file);
      const mode: Mode = command === "render" ? "final" : "draft";
      const r = await render(story, mode, values.beat, jobs);
      log(`rendered ${values.beat ? `beat ${values.beat}` : `${story.beats.length} beats`} (${mode}) in ${r.seconds.toFixed(1)}s: ` +
        `${r.drawn} drawn, ${r.cached} unchanged from the cache`);
      return report(story, mode, !values["no-listen"]);
    }
    case "check":
      return report(loadStory(file), values.draft ? "draft" : "final", !values["no-listen"]);
    default:
      throw new CouldNotRun(`unknown command ${command}; run node video.ts --help`);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.log(`could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
