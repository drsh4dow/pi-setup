// The catchup-video scenario's video metrics: the newest mp4 in the state folder, probed,
// opened, cut into its still slides, and whether the run looked at its frames. The files come from
// the copy of the state folder the runner kept; the run's paths name the live one.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { Option, Schema } from "effect";
import { argument, type Session } from "../lib/session.ts";
import { catchupStubPaths } from "./catchup-stubs.ts";
import {
  absolute,
  asker,
  callsDecidable,
  decodeOpenCall,
  jsonLines,
  LIVE_STATE,
  readOnly,
} from "./grade-catchup.ts";
import {
  all,
  flag,
  outcome,
  shellCommands,
  unknown,
  type FlagMetric,
  type Graded,
  type Unknown,
} from "./metrics.ts";
import type { GradeInput } from "./record.ts";
import { keptStateFolder } from "./state-folder.ts";

/** Every mp4 under `folder`, newest first. */
function videosIn(folder: string): string[] {
  if (!existsSync(folder)) return [];

  return readdirSync(folder, { recursive: true })
    .map((entry) => join(folder, String(entry)))
    .filter((path) => /\.mp4$/i.test(path) && statSync(path).isFile())
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

const Probe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      codec_type: Schema.String,
      width: Schema.optionalKey(Schema.Int),
      height: Schema.optionalKey(Schema.Int),
    }),
  ),
  format: Schema.Struct({
    duration: Schema.optionalKey(Schema.String),
    size: Schema.optionalKey(Schema.String),
  }),
});

const decodeProbe = Schema.decodeUnknownOption(Schema.fromJsonString(Probe));

type Probed = { readonly kind: "probed" } & typeof Probe.Type;

function probe(video: string): Probed | Unknown {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height:format=duration,size",
      "-of",
      "json",
      video,
    ],
    { encoding: "utf8" },
  );

  if (result.error !== undefined) return unknown(`ffprobe could not run: ${result.error.message}`);

  const parsed = decodeProbe(result.stdout);

  return Option.isSome(parsed)
    ? { kind: "probed", ...parsed.value }
    : unknown(`ffprobe failed: ${result.stderr.trim().slice(0, 300)}`);
}

function videoRendered(video: string | undefined, folder: string, session: Session): FlagMetric {
  if (video === undefined) {
    const mentioned = [
      ...new Set(
        shellCommands(session).flatMap((command) =>
          [...command.command.matchAll(/[^\s'"]+\.mp4\b/g)].map((match) => match[0]),
        ),
      ),
    ];

    return flag(
      false,
      `no mp4 under ${folder}; mp4 paths in the run's commands: ${mentioned.join(", ") || "none"}`,
    );
  }

  const facts = probe(video);

  if (facts.kind === "unknown") return facts;

  const videoStreams = facts.streams.filter((stream) => stream.codec_type === "video");
  const audio = facts.streams.filter((stream) => stream.codec_type === "audio").length;
  const { width = 0, height = 0 } = videoStreams[0] ?? {};

  return flag(
    videoStreams.length === 1 && audio === 0 && width > height,
    `${video}: ${videoStreams.length} video stream, ${audio} audio, ${width}x${height}, ${facts.format.duration ?? "?"} s, ${facts.format.size ?? "?"} bytes`,
  );
}

/** Whether the run opened `video`, given as the path the run wrote it at. */
function opened(video: string | undefined, outputDir: string): FlagMetric {
  const calls = jsonLines(catchupStubPaths(outputDir).open, decodeOpenCall);

  const shown =
    calls.map((call) => `xdg-open ${call.argv.join(" ")} (in ${call.cwd})`).join("; ") ||
    "no xdg-open call";

  if (video === undefined) return flag(false, `no video; ${shown}`);

  const hit = calls.some((call) => call.argv.some((arg) => absolute(arg, call.cwd) === video));

  return flag(hit, shown);
}

export interface Slide {
  readonly start: number;
  readonly hold: number;
}

/** The still stretches of a video, at least half a second each: one per slide. */
export function stillHolds(
  video: string,
  duration: number,
): { readonly kind: "holds"; readonly slides: readonly Slide[] } | Unknown {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      video,
      "-map",
      "0:v:0",
      "-vf",
      "freezedetect=n=0.003:d=0.5",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );

  if (result.error !== undefined || result.status !== 0)
    return unknown(
      `ffmpeg freezedetect failed: ${result.error?.message ?? result.stderr.slice(-300)}`,
    );

  const starts = [...result.stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((match) =>
    Number(match[1]),
  );

  const ends = [...result.stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((match) =>
    Number(match[1]),
  );

  return {
    kind: "holds",
    slides: starts.map((start, index) => ({ start, hold: (ends[index] ?? duration) - start })),
  };
}

function slides(video: string | undefined, outputDir: string): FlagMetric {
  if (video === undefined) return unknown("no video to count slides in");

  const facts = probe(video);
  const duration = facts.kind === "unknown" ? Number.NaN : Number(facts.format.duration);

  if (!Number.isFinite(duration)) return unknown(`no duration for ${video}`);

  const found = stillHolds(video, duration);

  if (found.kind === "unknown") return found;

  const holds = found.slides;

  const frames = join(outputDir, "slides");

  mkdirSync(frames, { recursive: true });

  const lines = holds.map((slide, index) => {
    const frame = join(frames, `slide-${String(index + 1).padStart(2, "0")}.png`);

    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-ss",
      String(slide.start + slide.hold / 2),
      "-i",
      video,
      "-frames:v",
      "1",
      frame,
    ]);

    return `${index + 1}: held ${slide.hold.toFixed(1)} s from ${slide.start.toFixed(1)} s${existsSync(frame) ? "" : " (no frame extracted)"}`;
  });

  return flag(
    holds.length >= 1 && holds.length <= 10,
    `${holds.length} slides (still holds of 0.5 s or more) in ${duration.toFixed(1)} s; frames in ${frames}\n${lines.join("\n")}`,
  );
}

const IMAGE = /\.(?:png|jpe?g|webp)$/i;

/** Whether the run pulled frames out of its rendered video and then looked at them. */
function framesLooked(video: string | undefined, session: Session): FlagMetric {
  if (video === undefined) return unknown("no video to look at");

  const name = basename(video);

  const first = shellCommands(session).find(
    (command) => /\bffmpeg\b/.test(command.command) && command.command.includes(name),
  );

  if (first === undefined) return flag(false, `no ffmpeg command read ${name}`);

  const looks = session.operations.filter(
    (operation) =>
      operation.tool === "read" &&
      operation.step > first.step &&
      IMAGE.test(argument(operation, "path") ?? ""),
  );

  return flag(
    looks.length > 0,
    `ffmpeg on ${name}: ${first.command.slice(0, 200)}\nimages read after it: ${looks.map((operation) => argument(operation, "path")).join(", ") || "none"}`,
  );
}

/** The metrics read from the newest mp4 in the state folder the runner kept. */
function videoMetrics({ session, outputDir }: GradeInput) {
  const kept = keptStateFolder(outputDir);

  if (!existsSync(kept)) {
    const none = unknown(`the runner kept no copy of the state folder at ${kept}`);

    return { rendered: none, open: none, stills: none, looked: none };
  }

  const video = videosIn(kept)[0];
  const written = video === undefined ? undefined : join(LIVE_STATE, relative(kept, video));

  return {
    rendered: videoRendered(video, kept, session),
    open: opened(written, outputDir),
    stills: slides(video, outputDir),
    looked: framesLooked(video, session),
  };
}

export async function catchupVideo(input: GradeInput): Promise<Graded> {
  const ask = asker(input);
  const reply = input.session.finalText;
  const video = videoMetrics(input);

  const metrics = {
    videoRendered: video.rendered,
    opened: video.open,
    readOnlyExceptVideo: readOnly(input, { video: true }),
    slides: video.stills,
    framesLooked: video.looked,
    replyLayout: await ask(
      "Is the final message shaped as one opening sentence naming what waits on the user, a link to the video file, one line naming work left that the agent can do itself, and then the calls waiting on the user, with no summary of what happened and no pictures or diagrams besides the video?",
    ),
    callsDecidable: await callsDecidable(ask),
  };

  return {
    metrics,
    primary: all(
      outcome(metrics.videoRendered),
      outcome(metrics.opened),
      outcome(metrics.readOnlyExceptVideo),
      outcome(metrics.callsDecidable),
    ),
    crossChecks: [
      {
        judged: "replyLayout",
        signal: /\.mp4\b/.test(reply) && !/!\[|```mermaid/.test(reply),
        signalMeaning: "an mp4 link and no image or Mermaid block",
      },
    ],
  };
}
