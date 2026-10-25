// The facts of a catchup video the grade reads for itself: what ffprobe says about the file,
// frames for a judge and a reviewer, and what the video says, transcribed by Gemini from its audio
// or read off its frames when it is silent. Frames and transcript are kept in the run's output
// directory and reused while the file is the same.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { gemini } from "./gemini.ts";
import { unknown, type Unknown } from "./metrics.ts";

/** Every finished mp4 under `folder`, newest first. Manim's partial movie files are not videos. */
export function videosIn(folder: string): string[] {
  if (!existsSync(folder)) return [];

  return readdirSync(folder, { recursive: true })
    .map((entry) => join(folder, String(entry)))
    .filter(
      (path) =>
        /\.mp4$/i.test(path) && !path.includes("/partial_movie_files/") && statSync(path).isFile(),
    )
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

const Probe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      codec_type: Schema.String,
      codec_name: Schema.optionalKey(Schema.String),
      width: Schema.optionalKey(Schema.Int),
      height: Schema.optionalKey(Schema.Int),
      avg_frame_rate: Schema.optionalKey(Schema.String),
    }),
  ),
  format: Schema.Struct({
    duration: Schema.optionalKey(Schema.String),
    size: Schema.optionalKey(Schema.String),
  }),
});

const decodeProbe = Schema.decodeUnknownOption(Schema.fromJsonString(Probe));

export interface VideoFacts {
  readonly kind: "facts";
  readonly path: string;
  readonly videoStreams: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly seconds: number;
  readonly bytes: number;
  readonly videoCodec: string;
  /** The first audio stream's codec, absent for a silent video. */
  readonly audioCodec: string | undefined;
}

const rate = (fraction: string | undefined) => {
  const [top = Number.NaN, bottom = 1] = (fraction ?? "").split("/").map(Number);

  return bottom === 0 ? 0 : top / bottom;
};

export function probe(video: string): VideoFacts | Unknown {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration,size",
      "-of",
      "json",
      video,
    ],
    { encoding: "utf8" },
  );

  if (result.error !== undefined) return unknown(`ffprobe could not run: ${result.error.message}`);

  const parsed = decodeProbe(result.stdout);

  if (Option.isNone(parsed))
    return unknown(`ffprobe failed: ${result.stderr.trim().slice(0, 300)}`);

  const streams = parsed.value.streams.filter((stream) => stream.codec_type === "video");
  const audio = parsed.value.streams.find((stream) => stream.codec_type === "audio");
  const first = streams[0];

  return {
    kind: "facts",
    path: video,
    videoStreams: streams.length,
    width: first?.width ?? 0,
    height: first?.height ?? 0,
    fps: rate(first?.avg_frame_rate),
    seconds: Number(parsed.value.format.duration ?? Number.NaN),
    bytes: Number(parsed.value.format.size ?? Number.NaN),
    videoCodec: first?.codec_name ?? "?",
    audioCodec: audio?.codec_name,
  };
}

export const describe = (facts: VideoFacts) =>
  `${facts.path}: ${facts.videoStreams} video stream (${facts.videoCodec}) ${facts.width}x${facts.height} at ${facts.fps.toFixed(2)} fps, ${facts.audioCodec === undefined ? "no audio" : `audio ${facts.audioCodec}`}, ${facts.seconds.toFixed(1)} s, ${facts.bytes} bytes`;

const EVEN_FRAMES = 10;

const SCENE_FRAMES = 8;

/** Up to `limit` items of `items`, spread evenly from first to last. */
function spread<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items];

  return Array.from(
    { length: limit },
    (_, index) => items[Math.round((index * (items.length - 1)) / (limit - 1))],
  ).filter((item) => item !== undefined);
}

/** The times of the video's cuts, from ffmpeg's scene score on a small copy of each frame. */
function sceneChanges(video: string): number[] {
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
      "scale=480:-2,select='gt(scene,0.3)',showinfo",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  return [...(result.stderr ?? "").matchAll(/Parsed_showinfo.*?pts_time:([\d.]+)/g)].map((match) =>
    Number(match[1]),
  );
}

function extractFrame(video: string, at: number, file: string): boolean {
  spawnSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    at.toFixed(3),
    "-i",
    video,
    "-frames:v",
    "1",
    file,
  ]);

  return existsSync(file);
}

const Manifest = Schema.Struct({
  video: Schema.String,
  bytes: Schema.Finite,
  frames: Schema.Array(Schema.String),
});

const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));

/**
 * Frames of the video for the judge and a human reviewer, in `<output>/frames/`: ten at even
 * intervals and up to eight at its cuts, in time order. Kept across grades of the same file.
 */
export function frames(facts: VideoFacts, outputDir: string): string[] {
  const dir = join(outputDir, "frames");
  const manifest = join(dir, "frames.json");

  const kept = existsSync(manifest)
    ? decodeManifest(readFileSync(manifest, "utf8"))
    : Option.none();

  if (
    Option.isSome(kept) &&
    kept.value.video === facts.path &&
    kept.value.bytes === facts.bytes &&
    kept.value.frames.every((frame) => existsSync(join(dir, frame)))
  )
    return kept.value.frames.map((frame) => join(dir, frame));

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const even = Array.from(
    { length: EVEN_FRAMES },
    (_, index) => ({ kind: "even", at: (facts.seconds * (index + 0.5)) / EVEN_FRAMES }) as const,
  );

  const cuts = spread(sceneChanges(facts.path), SCENE_FRAMES).map(
    (at) => ({ kind: "scene", at }) as const,
  );

  const written = [...even, ...cuts]
    .toSorted((a, b) => a.at - b.at)
    .flatMap((frame, index) => {
      const name = `${String(index + 1).padStart(2, "0")}-${frame.kind}-${frame.at.toFixed(1)}s.png`;

      return extractFrame(facts.path, frame.at, join(dir, name)) ? [name] : [];
    });

  writeFileSync(
    manifest,
    `${JSON.stringify({ video: facts.path, bytes: facts.bytes, frames: written }, null, 2)}\n`,
  );

  return written.map((frame) => join(dir, frame));
}

export const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";

export const CAPTION_MODEL = "gemini-3.8-flash";

const Transcript = Schema.Struct({
  video: Schema.String,
  bytes: Schema.Finite,
  source: Schema.Literals(["audio", "captions"]),
  model: Schema.String,
  text: Schema.String,
});

export type Transcript = typeof Transcript.Type;

const decodeTranscript = Schema.decodeUnknownOption(Schema.fromJsonString(Transcript));

const CAPTION_STEP_S = 2;

const CAPTION_FRAMES = 60;

/** What the video says: its audio transcribed, or for a silent video its captions read off frames. */
async function hear(facts: VideoFacts): Promise<Transcript | Unknown> {
  const scratch = mkdtempSync(join(tmpdir(), "catchup-video-grade-"));

  try {
    if (facts.audioCodec !== undefined) {
      const audio = join(scratch, "narration.mp3");

      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-i",
        facts.path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "48k",
        audio,
      ]);

      if (!existsSync(audio)) return unknown("ffmpeg could not extract the audio");

      const reply = await gemini(TRANSCRIBE_MODEL, [
        { inlineData: { mimeType: "audio/mp3", data: readFileSync(audio).toString("base64") } },
        { text: "Transcribe." },
      ]);

      return reply.kind === "text"
        ? {
            video: facts.path,
            bytes: facts.bytes,
            source: "audio",
            model: TRANSCRIBE_MODEL,
            text: reply.text,
          }
        : unknown(`transcription failed: ${reply.reason}`);
    }

    const times = spread(
      Array.from(
        { length: Math.ceil(facts.seconds / CAPTION_STEP_S) },
        (_, index) => index * CAPTION_STEP_S + 1,
      ),
      CAPTION_FRAMES,
    );

    const images = times.flatMap((at, index) => {
      const file = join(scratch, `caption-${index}.png`);

      return extractFrame(facts.path, at, file)
        ? [{ inlineData: { mimeType: "image/png", data: readFileSync(file).toString("base64") } }]
        : [];
    });

    const reply = await gemini(CAPTION_MODEL, [
      ...images,
      {
        text: `These are frames of a silent video, ${CAPTION_STEP_S} seconds apart, in time order. Write out the captions and any narration-like text they show, in order, as plain prose. Write text that stays on screen across frames once.`,
      },
    ]);

    return reply.kind === "text"
      ? {
          video: facts.path,
          bytes: facts.bytes,
          source: "captions",
          model: CAPTION_MODEL,
          text: reply.text,
        }
      : unknown(`reading the captions failed: ${reply.reason}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `hear`, kept in `<output>/transcript.json` so a regrade of the same file asks Gemini once. */
export async function transcript(
  facts: VideoFacts,
  outputDir: string,
): Promise<Transcript | Unknown> {
  const file = join(outputDir, "transcript.json");
  const kept = existsSync(file) ? decodeTranscript(readFileSync(file, "utf8")) : Option.none();

  if (Option.isSome(kept) && kept.value.video === facts.path && kept.value.bytes === facts.bytes)
    return kept.value;

  const heard = await hear(facts);

  if (!("kind" in heard)) writeFileSync(file, `${JSON.stringify(heard, null, 2)}\n`);

  return heard;
}
