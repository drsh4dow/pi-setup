import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseSession, type Session } from "../../lib/session.ts";
import { catchupVideo, framesLooked } from "../grade-catchup-video.ts";
import { renderKind, runTiming } from "../run-timing.ts";
import { keptStateFolder } from "../state-folder.ts";
import { TRANSCRIBE_MODEL } from "../video-file.ts";
import { evidence, LIVE, problems, stub, values, where } from "./catchup-support.ts";
import { bash, input, read, session, stubJudge, type Prepared } from "./support.ts";

// The grade transcribes and reads captions through Gemini. Without a key it cannot, so no test
// reaches the network: a test that needs a transcript writes the one the grade keeps.
delete process.env.GEMINI_API_KEY;

/** Where a test's video lives: the path the run wrote it at and the runner's kept copy. */
interface Video {
  readonly live: string;
  readonly kept: string;
}

/**
 * A video of still color scenes, 1.5 s each, with a tone standing in for narration unless it is
 * silent, in the run's state folder as the runner kept it.
 */
function renderVideo(
  at: Prepared,
  { size = "320x180", colors = ["red", "blue"], silent = false } = {},
): Video {
  const video = {
    live: join(LIVE, "catchup", "catchup.mp4"),
    kept: join(keptStateFolder(at.outputDir), "catchup", "catchup.mp4"),
  };

  const scenes = colors.flatMap((color) => [
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${size}:d=1.5:r=25`,
  ]);

  const tone = ["-f", "lavfi", "-i", `sine=frequency=440:duration=${1.5 * colors.length}`];
  const streams = colors.map((_, index) => `[${index}]`).join("");

  mkdirSync(dirname(video.kept), { recursive: true });
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...scenes,
    ...(silent ? [] : tone),
    "-filter_complex",
    `${streams}concat=n=${colors.length}:v=1[v]`,
    "-map",
    "[v]",
    ...(silent ? [] : ["-map", `${colors.length}:a`, "-c:a", "aac"]),
    "-pix_fmt",
    "yuv420p",
    video.kept,
  ]);

  return video;
}

/** What the transcriber heard in `video`, kept where a regrade finds it instead of asking Gemini. */
function heard(at: Prepared, video: Video, text: string) {
  writeFileSync(
    join(at.outputDir, "transcript.json"),
    JSON.stringify({
      video: video.kept,
      bytes: statSync(video.kept).size,
      source: "audio",
      model: TRANSCRIBE_MODEL,
      text,
    }),
  );
}

const T0 = Date.parse("2026-10-24T15:00:00.000Z");

const stamp = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

/** A bash call the run sent at second `from` of its turn, its result back at second `to`. */
interface Step {
  readonly command: string;
  readonly from: number;
  readonly to: number;
}

/**
 * The run's turn as its raw session file in the output directory, each assistant message costing
 * $0.25, and the session the grade parses from it.
 */
function turn(prep: Prepared, steps: readonly Step[], reply: string): Session {
  const cost = { cost: { total: 0.25 } };

  const lines = [
    {
      type: "message",
      timestamp: stamp(0),
      message: { role: "user", content: "/skill:catchup-video" },
    },
    ...steps.flatMap((step, index) => [
      {
        type: "message",
        timestamp: stamp(step.from),
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call-${index}`,
              name: "bash",
              arguments: { command: step.command },
            },
          ],
          usage: cost,
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        timestamp: stamp(step.to),
        message: { role: "toolResult", toolCallId: `call-${index}`, content: [], isError: false },
      },
    ]),
    {
      type: "message",
      timestamp: stamp((steps.at(-1)?.to ?? 0) + 5),
      message: {
        role: "assistant",
        content: [{ type: "text", text: reply }],
        usage: cost,
        stopReason: "stop",
      },
    },
  ];

  const jsonl = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;

  writeFileSync(join(prep.outputDir, "session.jsonl"), jsonl);

  return parseSession(jsonl);
}

const REPLY = (video: Video) =>
  `Three calls wait on you.\n\n[Video](${video.live})\n\nWork left: the lint fix on #53.\n\n1. Merge #51 and #52.`;

test("catchup-video passes a narrated, opened, landscape video and times the run and its renders", async () => {
  const prep = where();
  const video = renderVideo(prep);
  const written = new Date(T0 + 85_000);

  heard(prep, video, "Three changes landed. Merge the cent fix and the page change.");
  utimesSync(video.kept, written, written);
  stub(prep, "xdg-open", [video.live]);

  const run = turn(
    prep,
    [
      { command: `cd ${join(LIVE, "catchup")} && manim -ql story.py Catchup`, from: 5, to: 25 },
      {
        command: "node /harness/agent/skills/catchup-video/scripts/video.ts render story.py",
        from: 30,
        to: 80,
      },
      { command: `xdg-open ${video.live}`, from: 90, to: 91 },
    ],
    REPLY(video),
  );

  const judge = stubJudge(true);
  const graded = await catchupVideo(input("catchup-video", prep, run, judge));
  const { videoSeconds, ...metrics } = values(graded.metrics);

  assert.deepEqual(metrics, {
    wallSeconds: 1,
    costUsd: 1,
    secondsToFirstVideo: 80,
    renders: 2,
    renderSeconds: 70,
    videoRendered: true,
    narrated: true,
    opened: true,
    // This toolkit stand-in writes no frames; the framesLooked test covers reading them.
    framesLooked: "unknown",
    readOnlyExceptVideo: true,
    saysCalls: true,
    numbersRight: true,
    correctsWrongStatement: true,
    inventsNothing: true,
    readableText: true,
    nothingOverlaps: true,
    onePicture: true,
    colorMeaning: true,
    explainerLook: true,
    replyLayout: true,
    callsDecidable: true,
  });
  assert.ok(Math.abs(Number(videoSeconds) - 3) < 0.2, `videoSeconds ${String(videoSeconds)}`);
  assert.match(evidence(graded.metrics.renders), /^1 draft, 1 final\ndraft 20 s: .*manim/);
  assert.match(evidence(graded.metrics.videoRendered), /320x180 at 25\.00 fps, audio aac/);

  const shown = judge.requests.filter((request) => (request.images ?? []).length > 0);

  assert.equal(shown.length, 5);
  assert.ok(shown.every((request) => (request.images ?? []).every((frame) => existsSync(frame))));
  assert.ok(
    judge.requests.some((request) =>
      request.artifacts.some(
        (artifact) =>
          artifact.label === "TRANSCRIPT" && artifact.text.includes("Three changes landed"),
      ),
    ),
  );
  assert.equal(graded.primary, "pass");
});

test("catchup-video leaves what a silent video says undecided when Gemini is out of reach", async () => {
  const prep = where();
  const video = renderVideo(prep, { silent: true });

  stub(prep, "xdg-open", [video.live]);

  const run = turn(prep, [{ command: `xdg-open ${video.live}`, from: 5, to: 6 }], REPLY(video));
  const graded = await catchupVideo(input("catchup-video", prep, run, stubJudge(true)));
  const metrics = values(graded.metrics);

  assert.equal(metrics.narrated, false);
  assert.match(evidence(graded.metrics.narrated), /^no audio stream/);
  assert.equal(metrics.saysCalls, "unknown");
  assert.match(evidence(graded.metrics.saysCalls), /GEMINI_API_KEY is unset/);
  assert.equal(metrics.readableText, true, "the frames are judged without a transcript");
  assert.equal(metrics.renders, 0);
  assert.equal(graded.primary, "unknown");
});

test("catchup-video does not time the first video by a kept copy's file times", async () => {
  const prep = where();
  const video = renderVideo(prep);

  heard(prep, video, "Three changes landed.");

  const run = turn(prep, [{ command: "ls", from: 5, to: 6 }], REPLY(video));
  const graded = await catchupVideo(input("catchup-video", prep, run, stubJudge(true)));

  assert.equal(values(graded.metrics).secondsToFirstVideo, "unknown");
  assert.match(evidence(graded.metrics.secondsToFirstVideo), /copy times/);
});

test("catchup-video counts a render in a background terminal until its results arrive", () => {
  const lines = [
    { type: "message", timestamp: stamp(0), message: { role: "user", content: "go" } },
    {
      type: "message",
      timestamp: stamp(10),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-0",
            name: "bg_start",
            arguments: { command: "node scripts/video.ts draft story.py", title: "draft" },
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: stamp(11),
      message: { role: "toolResult", toolCallId: "call-0", details: { id: "bt-1" } },
    },
    {
      type: "custom_message",
      customType: "background-terminal-results",
      details: { terminals: [{ id: "bt-1", elapsedMs: 42_000 }] },
    },
  ];

  const timing = runTiming(lines.map((line) => JSON.stringify(line)).join("\n"));
  const [render] = timing.commands;

  assert.equal(render === undefined ? undefined : renderKind(render.command), "draft");
  assert.equal(render?.endMs === undefined ? undefined : render.endMs - render.startMs, 42_000);
});

test("catchup-video fails without a video and leaves what it says and shows undecided", async () => {
  const prep = where();

  mkdirSync(keptStateFolder(prep.outputDir));

  stub(prep, "xdg-open", [join(prep.workdir, "README.md")]);

  const graded = await catchupVideo(
    input(
      "catchup-video",
      prep,
      session([bash("node render.mjs > /tmp/out.mp4")], "Render failed."),
      stubJudge(true),
    ),
  );

  const metrics = values(graded.metrics);

  assert.deepEqual(
    [metrics.videoRendered, metrics.opened, metrics.readOnlyExceptVideo],
    [false, false, false],
  );
  assert.deepEqual(
    [metrics.narrated, metrics.saysCalls, metrics.readableText],
    ["unknown", "unknown", "unknown"],
  );
  assert.match(
    evidence(graded.metrics.videoRendered),
    /mp4 paths in the run's commands: \/tmp\/out\.mp4/,
  );
  assert.match(problems(graded.metrics.readOnlyExceptVideo), /xdg-open .*README\.md/);
  assert.equal(graded.primary, "fail");
});

test("catchup-video leaves the video metrics undecided for a run the runner kept no state of", async () => {
  const prep = where();

  stub(prep, "xdg-open", [join(LIVE, "catchup.mp4")]);

  const graded = await catchupVideo(
    input(
      "catchup-video",
      prep,
      session([bash(`xdg-open ${join(LIVE, "catchup.mp4")}`)], "Done."),
      stubJudge(true),
    ),
  );

  const metrics = values(graded.metrics);

  assert.deepEqual(
    [metrics.videoRendered, metrics.narrated, metrics.opened],
    ["unknown", "unknown", "unknown"],
  );
  assert.equal(metrics.readOnlyExceptVideo, true, evidence(graded.metrics.readOnlyExceptVideo));
  assert.equal(graded.primary, "unknown");
});

test("catchup-video fails a portrait video that was never opened", async () => {
  const prep = where();
  const video = renderVideo(prep, { size: "180x320" });

  heard(prep, video, "Three changes landed.");

  const graded = await catchupVideo(
    input("catchup-video", prep, session([], "Done."), stubJudge(true)),
  );

  assert.equal(values(graded.metrics).videoRendered, false);
  assert.match(evidence(graded.metrics.videoRendered), /180x320/);
  assert.equal(values(graded.metrics).opened, false);
  assert.equal(graded.primary, "fail");
});

test("framesLooked needs every contact sheet of the final render read after it", () => {
  const prep = where();
  const video = join(keptStateFolder(prep.outputDir), "catchup", "story.mp4");
  const frames = join(dirname(video), "story.build", "final", "frames");
  const live = join(LIVE, "catchup", "story.build", "final", "frames");
  const render = bash("node /harness/agent/skills/catchup-video/scripts/video.ts render story.py");

  mkdirSync(frames, { recursive: true });
  for (const name of ["sheet-1.png", "sheet-2.png", "beat-01-mid.png"])
    writeFileSync(join(frames, name), "");

  const both = [read(join(live, "sheet-1.png")), read(join(live, "sheet-2.png"))];
  const looked = (calls: Parameters<typeof session>[0]) =>
    values({ looked: framesLooked(video, session(calls)) }).looked;

  assert.equal(looked([render, ...both]), true);
  assert.equal(looked([render, both[0]!]), false);
  assert.equal(looked([...both, render]), false);
  assert.equal(looked(both), "unknown");
  assert.equal(framesLooked(undefined, session([])).kind, "unknown");
});
