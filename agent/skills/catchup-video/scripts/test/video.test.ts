import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const VIDEO = fileURLToPath(new URL("../video.ts", import.meta.url));
// Drafts never call a voice provider; without keys a stray call could not reach one either.
const ENV = { ...process.env, GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "" };

function video(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [VIDEO, ...args], { encoding: "utf8", env: ENV, input, maxBuffer: 1 << 26 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function story(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-video-"));
  const file = path.join(dir, "story.py");
  fs.writeFileSync(file, `from catchup_video import *\n\n\nclass Story(Video):\n${source}`);
  return file;
}

const probe = (file: string, entries: string) =>
  spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0", file],
    { encoding: "utf8" }).stdout.trim();

const timingOf = (file: string): { total: number; beats: { start: number }[] } =>
  JSON.parse(fs.readFileSync(file.replace(/\.py$/, ".build/draft/timing.json"), "utf8"));

test("a story written from a skeleton drafts clean in parallel chunks that join without drift", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-video-"));
  const file = path.join(dir, "story.py");
  const made = video(["new", file], "Two changes landed.\nFifty gifts per page || 50 gifts per page\nOne waits on you.\nThat is all.\n");
  assert.equal(made.code, 0, made.out + made.err);
  assert.match(fs.readFileSync(file, "utf8"), /@beat\("Fifty gifts per page", show="50 gifts per page"\)/);

  const r = video(["draft", file, "--jobs", "3"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /check: clean/);
  const frames = fs.readdirSync(path.join(dir, "story.build", "draft", "frames"));
  assert.equal(frames.filter((f) => /^beat-\d\d-(mid|end)\.png$/.test(f)).length, 8);
  assert.ok(frames.includes("sheet-1.png"));
  assert.equal(Number(probe(path.join(dir, "story.draft.mp4"), "stream=nb_read_frames")), Math.round(timingOf(file).total * 15));
});

test("the check names the beat and element of every problem and exits 1", () => {
  const file = story(`
    @beat("One beat with problems in it, held long enough to read every word of it.")
    def broken(self):
        self.add(text("tiny words", size=20).move_to(UP * 2))
        self.add(name(Square(2, color=T.RED), "red square").move_to(RIGHT * 7.5))
        self.add(text("left words").move_to(DOWN * 0.5), text("right words").move_to(DOWN * 0.5 + RIGHT * 0.8))

    @beat("This one runs too long.")
    def long(self):
        self.hold(9)
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^beat 1 \(broken\) mid and end: red square leaves the frame on the right by \d+ px$/m);
  assert.match(r.out, /^beat 1 \(broken\) mid and end: .*text "tiny words" is 20 px, below the 36 px minimum$/m);
  assert.match(r.out, /^beat 1 \(broken\) mid and end: text "left words" of .* overlaps text "right words" of .*$/m);
  assert.match(r.out, /^beat 2 \(long\): runs [\d.]+s past its slot/m);
});

// A fade that would be half done at the midpoint: one that lands on it, and one that starts after it.
const fades = [[0, 3.5, "whole", [0xfc, 0x62, 0x55]], [1.5, 3.3, "not yet", [0x0f, 0x12, 0x18]]] as const;
for (const [wait, runTime, want, color] of fades) {
  test(`an animation across a beat's midpoint moves off it, so the midpoint frame shows it ${want}`, () => {
    const file = story(`
    @beat("A red square fades in slowly across the middle of this beat, then holds still.")
    def fade(self):
        self.hold(${wait}) if ${wait} else None
        self.play(FadeIn(Square(3, fill_color="#FC6255", fill_opacity=1, stroke_width=0)), run_time=${runTime})
`);
    const r = video(["draft", file]);
    assert.equal(r.code, 0, r.out + r.err);
    const png = file.replace(/story\.py$/, "story.build/draft/frames/beat-01-mid.png");
    const rgb = [...spawnSync("ffmpeg", ["-v", "error", "-i", png, "-vf", "crop=1:1:427:200", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
    assert.ok(rgb.length === 3 && rgb.every((v, i) => Math.abs(v - (color[i] ?? 0)) < 14), `mid pixel ${rgb.join(",")}`);
  });
}

test("a draft of one beat renders that beat's slot alone", () => {
  const file = story(`
    @beat("First words to read here.")
    def one(self):
        self.show(text("one"))

    @beat("Second words, a little longer, to read here.")
    def two(self):
        self.clear()
        self.show(text("two"))

    @beat("Third.")
    def three(self):
        pass
`);
  const r = video(["draft", file, "--beat", "two"]);
  assert.equal(r.code, 0, r.out + r.err);
  const [, two, three] = timingOf(file).beats;
  const seconds = Number(probe(file.replace(/\.py$/, ".draft-two.mp4"), "format=duration"));
  assert.ok(Math.abs(seconds - ((three?.start ?? 0) - (two?.start ?? 0))) < 0.1, `${seconds}s`);
});

test("a story that does not load exits 2 with the reason", () => {
  const r = video(["draft", story("    @beat(\"Broken.\")\n    def broken(self)\n        pass\n")]);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /could not run: .*SyntaxError/s);
});

test("primitives lists every piece in one line each and a worked story", () => {
  const r = video(["primitives"]);
  assert.equal(r.code, 0, r.err);
  for (const piece of ["Code(src", "Eq(expr", "Number(value", "Branches(prs", "Shot(path", "Tiles(n", "Bars(rows",
    "Options(items", "Tag(words", "arrow(a, b", "Grid(cols", "self.dive(graph, n", "@beat(say"]) {
    assert.ok(r.out.includes(piece), piece);
  }
  assert.match(r.out, /class Story\(Video\):/);
});
