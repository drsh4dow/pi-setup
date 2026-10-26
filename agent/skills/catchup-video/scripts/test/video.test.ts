import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const VIDEO = fileURLToPath(new URL("../video.ts", import.meta.url));
// Without keys a draft finds no voice provider and times its beats at reading pace. The beats it
// draws go to a cache of the test's own.
const ENV = { ...process.env, GEMINI_API_KEY: "", ELEVENLABS_API_KEY: "",
  CATCHUP_BEAT_CACHE: fs.mkdtempSync(path.join(os.tmpdir(), "catchup-beats-")) };

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

test("a story written from a skeleton drafts in parallel chunks that join without drift, and the check names its empty beats", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-video-"));
  const file = path.join(dir, "story.py");
  const made = video(["new", file], "Two changes landed.\nFifty gifts per page || 50 gifts per page\n[curious] One waits on you.\nRecap.\n");
  assert.equal(made.code, 0, made.out + made.err);
  const skeleton = fs.readFileSync(file, "utf8");
  assert.match(skeleton, /@beat\("Fifty gifts per page", show="50 gifts per page"\)/);
  assert.match(skeleton, /def one_waits_on_you\(self\)/, "an audio tag stays out of the beat's name");
  assert.match(skeleton, /def recap_beat\(self\)/, "a beat named like a Video method gets a suffix");

  const r = video(["draft", file, "--jobs", "3"]);
  assert.equal(r.code, 1, r.out + r.err);
  const problems = r.out.split("\n").filter((l) => l.startsWith("beat "));
  assert.deepEqual(problems.map((l) => l.replace(/\).*/, ")")), ["beat 1 (two_changes_landed)", "beat 2 (fifty_gifts_per_page)",
    "beat 3 (one_waits_on_you)", "beat 4 (recap_beat)"]);
  for (const p of problems) assert.match(p, /: nothing but the header is on stage at its midpoint and end: show what its words say, or make it a transition$/);
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
        self.play(FadeIn(Square()), run_time=9)
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^beat 1 \(broken\) mid and end: red square leaves the frame on the right by \d+ px$/m);
  assert.match(r.out, /^beat 1 \(broken\) mid and end: .*text "tiny words" is 20 px, below the 36 px minimum$/m);
  assert.match(r.out, /^beat 1 \(broken\) mid and end: text "left words" of .* overlaps text "right words" of .*$/m);
  assert.match(r.out, /^beat 2 \(long\): runs [\d.]+s past its slot even with its animations sped up to twice their speed; in this beat it plays FadeIn Square at .* \(9\.0s\): cut one of them/m);
});

test("the check sees the parts of a composite piece and names the two that overlap", () => {
  const file = story(`
    @beat("Two pull requests, and the second one's number is pushed into its node.")
    def graph(self):
        self.graph = Branches({51: "Fix split gifts", 52: "Show fifty gifts"})
        self.graph.label(52).shift(LEFT * 0.6)
        self.add(self.graph)

    @beat("Two options, and the second card is pushed over the first.")
    def cards(self):
        self.clear()
        pick = Options([("Keep it", ["simple"]), ("Change it", ["costly"])])
        pick.submobjects[1].shift(LEFT * 3)
        self.add(pick)
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 1, r.out + r.err);
  const problems = r.out.split("\n").filter((l) => l.startsWith("beat "));
  assert.deepEqual(problems, [
    "beat 1 (graph) mid and end: Branches: #52 node overlaps #52 number",
    'beat 2 (cards) mid and end: Options: card "Keep it" overlaps card "Change it"',
  ]);
});

test("an animation longer than its beat is sped up to end with it, and the video keeps its length", () => {
  const file = story(`
    @beat("Short words here.")
    def short(self):
        self.play(FadeIn(name(Square(2), "square")), run_time=3.5)

    @beat("And the next beat starts on time.")
    def next_one(self):
        self.show(name(Circle(), "circle").shift(RIGHT * 3))
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /check: clean/);
  assert.equal(Number(probe(file.replace(/\.py$/, ".draft.mp4"), "stream=nb_read_frames")), Math.round(timingOf(file).total * 15));
});

test("the check names a beat that leaves the stage idle, unless it is a transition", () => {
  const file = story(`
    @beat("A square comes in.")
    def one(self):
        self.show(name(Square(2), "square"))

    @beat("Nothing new is shown while these words play out.")
    def same(self):
        pass

    @beat("A transition may hold the picture.", transition=True)
    def held(self):
        pass

    @beat("The stage is cleared and left empty for these words.")
    def emptied(self):
        self.clear()
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.deepEqual(r.out.split("\n").filter((l) => l.startsWith("beat ")), [
    "beat 2 (same): the stage at its midpoint and end is the picture the beat before ended on: show what its words add, or make it a transition",
    "beat 4 (emptied): nothing but the header is on stage at its midpoint and end: show what its words say, or make it a transition",
  ]);
});

test("pieces fit themselves: forty PRs, wrapped words, a long pipeline with notes on neighbors, and wide code check clean", () => {
  const prs = Array.from({ length: 40 }, (_, k) => `${200 + k}: "Change ${k} with a title long enough to need shortening"`);
  const file = story(`
    @beat("Forty pull requests moved, and three are marked.")
    def graph(self):
        self.graph = Branches({${prs.join(", ")}})
        self.play(self.graph.draw())
        self.play(self.graph.mark(200), self.graph.mark(201, icon_kind="cross", color=T.RED), self.graph.ring(202))

    @beat("Words wrap to their room, and a pipeline of seven steps fits the stage.")
    def pieces(self):
        g = Grid(2, 2)
        words = g.put(text("A sentence long enough that it has to wrap onto a second line to fit its cell"), 0, 0)
        code = g.put(Code("total = split_shares(price, guests)\\n" * 3, path="src/a/long/path/to/checkout.py"), 1, 0)
        flow = g.put(Flow(["open", "build", "test", "review", "stage", "deploy", "watch"]), 0, 1, cs=2)
        self.clear(extra=[FadeIn(words), FadeIn(code), flow.grow()])

    @beat("Two neighboring steps get a note each, and the notes stay apart.")
    def notes(self):
        flow = Flow(["merge", "build", "deploy", "watch"])
        self.clear(extra=[flow.grow()])
        self.play(flow.flag(1, "nobody reviews the build"), flow.flag(2, "deploys on its own"))
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /check: clean/);
});

test("a request that cannot fit at the minimum size is reported with what to cut", () => {
  const file = story(`
    @beat("This tag has far too many words for its narrow room.")
    def crowded(self):
        self.show(Tag("a very long note " * 12, T.RED, width=2.5))
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^beat 1 \(crowded\): text "a very long note .*" does not fit \d+ px in 2 line\(s\) at the 36 px minimum: cut it to about \d+ characters or give it more room$/m);
});

test("a second draft redraws only the beats whose code or starting picture changed", () => {
  const source = (runTime: string, color: string) => `
    @beat("A square fades in.")
    def one(self):
        self.square = Square(2)
        self.play(FadeIn(self.square), run_time=${runTime})

    @beat("It turns a color.")
    def two(self):
        self.play(self.square.animate.set_color(T.BLUE))

    @beat("A circle joins it.")
    def three(self):
        self.show(Circle(color=${color}).next_to(self.square, RIGHT))
`;
  const file = story(source("0.8", "T.GREEN"));
  const drawn = () => {
    const r = video(["draft", file]);
    assert.equal(r.code, 0, r.out + r.err);
    return /(\d+) drawn, (\d+) unchanged/.exec(r.err)?.slice(1).map(Number);
  };
  assert.deepEqual(drawn(), [3, 0]);
  assert.deepEqual(drawn(), [0, 3]);
  // A slower fade ends on the same picture, so the beats after it keep their frames.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(source("0.8", "T.GREEN"), source("1.2", "T.GREEN")));
  assert.deepEqual(drawn(), [1, 2]);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(source("1.2", "T.GREEN"), source("1.2", "T.RED")));
  assert.deepEqual(drawn(), [1, 2]);
});

test("a beat's audio tags never reach its captions, and its cues match the spoken words", () => {
  const file = story(`
    @beat("[curious] Two changes landed, [short pause] and one waits on you.")
    def tagged(self):
        self.at("one waits")
        self.show(text("one"))
`);
  const r = video(["draft", file]);
  assert.equal(r.code, 0, r.out + r.err);
  const ass = fs.readFileSync(file.replace(/\.py$/, ".build/draft/captions.ass"), "utf8");
  assert.match(ass, /Two changes landed, and one waits on you\./);
  for (const line of ass.split("\n").filter((l) => l.startsWith("Dialogue:"))) assert.doesNotMatch(line, /curious|short pause/);
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
    "Options(items", "Tag(words", "arrow(a, b", "Grid(cols", "self.dive(graph, n", "@beat(say", "Flow(steps",
    "Correction(said", "Tally(groups", "Compare(left", ".note(line", "self.beside(mob", "self.recap(graph"]) {
    assert.ok(r.out.includes(piece), piece);
  }
  assert.match(r.out, /class Story\(Video\):/);
});
