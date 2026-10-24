import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../render.ts", import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function scratch(deck: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catchup-video-"));
  fs.writeFileSync(path.join(dir, "deck.json"), JSON.stringify(deck));
  return dir;
}

function tool(command: string, args: string[]) {
  const r = spawnSync(command, args);
  assert.equal(r.status, 0, `${command} ${args.join(" ")}: ${r.error?.message ?? r.stderr.toString()}`);
  return r.stdout;
}

const render = (dir: string, out: string, ...more: string[]) =>
  spawnSync(process.execPath, [SCRIPT, dir, "--out", path.join(dir, out), ...more], { encoding: "utf8" });

// The color of one pixel of a PNG, as [red, green, blue].
const pixel = (png: string, x: number, y: number) => [
  ...tool("ffmpeg", ["-v", "error", "-i", png, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]),
];
const isRed = ([r, g, b]: number[]) => r > 130 && g < 100 && b < 110;

describe("a deck that renders", () => {
  let dir = "";
  let result: ReturnType<typeof render>;
  before(() => {
    dir = scratch({
      colors: { broken: "red" },
      slides: [
        {
          put: {
            shot: { kind: "image", src: "shot.png", at: [0, 0, 800, 600] },
            ring: { kind: "highlight", on: "shot", at: [100, 100, 200, 100], color: "broken" },
            note: { kind: "text", text: "Search was slow", at: [900, 60, 900, 80] },
          },
        },
        {
          put: {
            shot: { at: [1000, 400, 400, 300] },
            flow: { kind: "mermaid", source: "flowchart LR\n  a[Search] --> b[Every gift]:::broken", at: [60, 60, 800, 300] },
          },
        },
      ],
    });
    // A 400x300 light grey screenshot, so a red ring on it is easy to find.
    tool("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0xdddddd:s=400x300", "-frames:v", "1", path.join(dir, "shot.png")]);
    result = render(dir, "out.mp4");
  });

  test("exits 0 with a passing line for each slide and a frame per slide", () => {
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    for (const [i, line] of lines.entries()) {
      const frame = path.join(dir, `out.slide-0${i + 1}.png`);
      assert.ok(line.startsWith(frame) && line.endsWith("PASS"), line);
      assert.deepEqual(fs.readFileSync(frame).subarray(0, 8), PNG_SIGNATURE);
    }
  });

  test("writes a silent 1920x1080 H.264 video of at least 24 frames a second", () => {
    const probe: unknown = JSON.parse(
      tool("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json", path.join(dir, "out.mp4")]).toString(),
    );
    assert.ok(typeof probe === "object" && probe !== null && "streams" in probe && Array.isArray(probe.streams));
    assert.equal(probe.streams.length, 1);
    const [video] = probe.streams;
    assert.equal(video.codec_type, "video");
    assert.equal(video.codec_name, "h264");
    assert.equal(`${video.width}x${video.height}`, "1920x1080");
    const [num, den] = String(video.avg_frame_rate).split("/").map(Number);
    assert.ok(num / den >= 24, `frame rate ${video.avg_frame_rate}`);
  });

  test("a highlight on a screenshot stays on its pixels when a later slide moves and shrinks it", () => {
    // Slide 1 draws the 400x300 shot at 2x from (0, 0): the ring's left edge is at x = 200.
    // Slide 2 draws it at 1x from (1000, 400): the ring's left edge is at x = 1100.
    const [first, second] = [1, 2].map((n) => path.join(dir, `out.slide-0${n}.png`));
    assert.ok(isRed(pixel(first, 203, 300)), `slide 1 ring: ${pixel(first, 203, 300)}`);
    assert.ok(isRed(pixel(second, 1103, 550)), `slide 2 ring: ${pixel(second, 1103, 550)}`);
    assert.ok(!isRed(pixel(second, 203, 300)), "slide 2 still shows the ring where the shot was");
  });

  test("the check fails a video whose frames do not show the deck's slides", () => {
    const flipped = path.join(dir, "flipped.mp4");
    tool("ffmpeg", ["-v", "error", "-i", path.join(dir, "out.mp4"), "-vf", "hflip", "-c:v", "libx264", "-pix_fmt", "yuv420p", flipped]);
    const r = render(dir, "flipped.mp4", "--check-only");
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /FAIL/);
  });
});

test("a hold too short for the slide's words exits 1 and names the slide", () => {
  const dir = scratch({
    slides: [
      { put: { a: { kind: "text", text: "Two words", at: [60, 60, 900, 80] } } },
      { put: { b: { kind: "text", text: "one two three four five six seven eight nine ten", at: [60, 300, 1800, 80] } }, hold: 1 },
    ],
  });
  const r = render(dir, "out.mp4");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /slide 2\.hold/);
  assert.doesNotMatch(r.stderr, /slide 1/);
  assert.ok(!fs.existsSync(path.join(dir, "out.mp4")));
});

test("an invalid deck exits 1 and lists every problem", () => {
  const dir = scratch({
    colors: { broken: "red", failed: "red" },
    slides: [
      { put: { a: { kind: "text", text: "Hi", at: [60, 60, 900, 80], color: "fixed" } } },
      { put: { b: { kind: "text", at: [60, 300, 900, 80] }, c: { kind: "circle" } }, remove: ["gone"] },
    ],
  });
  const r = render(dir, "out.mp4");
  assert.equal(r.status, 1, r.stderr);
  for (const where of ["colors.failed", "slide 1, a.color", "slide 2, b.text", "slide 2, c.kind", "slide 2.remove"])
    assert.ok(r.stderr.includes(`${where}:`), `missing ${where} in:\n${r.stderr}`);
});

test("exits 2 when ffmpeg is missing", () => {
  const dir = scratch({ slides: [{ put: { a: { kind: "text", text: "Hi", at: [60, 60, 900, 80] } } }] });
  const r = spawnSync(process.execPath, [SCRIPT, dir, "--out", path.join(dir, "out.mp4")], { encoding: "utf8", env: { PATH: "/nonexistent" } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /ffmpeg/);
});
