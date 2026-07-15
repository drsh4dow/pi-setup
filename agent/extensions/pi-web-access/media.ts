import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mapConcurrent } from "./concurrency.ts";
import {
  analyzeLocalVideo,
  analyzeYouTube,
  DEFAULT_GEMINI_MODEL,
  type VideoFile,
} from "./gemini-video.ts";
import type {
  ExtractedContent,
  FetchOptions,
  FrameData,
  FrameResult,
  VideoFrame,
} from "./types.ts";
import {
  extractLocalFrame,
  extractYouTubeFrame,
  getLocalDuration,
  getYouTubeStream,
  type YouTubeStream,
} from "./video-frames.ts";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_FRAMES = 12;
const FRAME_CONCURRENCY = 2;
const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL_SECONDS = 5;

const DEFAULT_VIDEO_PROMPT = `Extract the complete content of this video. Include:
1. Video title and duration
2. A brief summary
3. A full transcript with timestamps
4. Descriptions of code, commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const VIDEO_TYPES: Record<string, string> = {
  ".3gp": "video/3gpp",
  ".3gpp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
};

const YOUTUBE_PATTERN =
  /(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

interface MediaTarget {
  kind: "youtube" | "local";
  input: string;
  videoId?: string;
  local?: VideoFile;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aborted(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("abort");
}

function youtubeVideoId(input: string): string | null {
  try {
    const parsed = new URL(input);
    if (parsed.pathname === "/playlist") return null;
  } catch {
    return null;
  }
  return input.match(YOUTUBE_PATTERN)?.[1] ?? null;
}

function normalizeSpaces(value: string): string {
  return value.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

function resolveLocalPath(filePath: string): string | null {
  const absolutePath = resolve(filePath);
  if (existsSync(absolutePath)) return absolutePath;
  const parent = dirname(absolutePath);
  if (!existsSync(parent)) return null;
  const normalized = normalizeSpaces(basename(absolutePath));
  try {
    const match = readdirSync(parent).find(
      (entry) => normalizeSpaces(entry) === normalized,
    );
    return match ? join(parent, match) : null;
  } catch {
    return null;
  }
}

function inspectLocalVideo(
  input: string,
): { video?: VideoFile; error?: string } | null {
  const looksLocal =
    input.startsWith("/") ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("file://");
  if (!looksLocal) return null;

  let filePath = input;
  if (input.startsWith("file://")) {
    try {
      filePath = decodeURIComponent(new URL(input).pathname);
    } catch {
      return { error: "Invalid file URL" };
    }
  }

  const mimeType = VIDEO_TYPES[extname(filePath).toLowerCase()];
  if (!mimeType) return null;
  const absolutePath = resolveLocalPath(filePath);
  if (!absolutePath) return { error: `Video file not found: ${filePath}` };

  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) return { error: `Not a file: ${filePath}` };
    if (stats.size > MAX_VIDEO_BYTES) {
      return { error: "Local video exceeds the 50 MB limit" };
    }
    return {
      video: { absolutePath, mimeType, sizeBytes: stats.size },
    };
  } catch (error) {
    return { error: `Could not inspect video: ${errorMessage(error)}` };
  }
}

function target(input: string): MediaTarget | { error: string } | null {
  const videoId = youtubeVideoId(input);
  if (videoId) return { kind: "youtube", input, videoId };
  const local = inspectLocalVideo(input);
  if (!local) return null;
  if (local.error) return { error: local.error };
  if (!local.video) return null;
  return { kind: "local", input, local: local.video };
}

function parseSeconds(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
  const parts = value.split(":").map(Number);
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => !Number.isFinite(part) || part < 0)
  ) {
    return null;
  }
  return Math.floor(
    parts.length === 3
      ? parts[0] * 3_600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1],
  );
}

export type TimestampSpec =
  | { type: "single"; seconds: number }
  | { type: "range"; start: number; end: number };

export function parseTimestamp(value: string): TimestampSpec | null {
  const separator = value.indexOf("-", 1);
  if (separator > 0) {
    const start = parseSeconds(value.slice(0, separator));
    const end = parseSeconds(value.slice(separator + 1));
    if (start !== null && end !== null && end > start) {
      return { type: "range", start, end };
    }
    return null;
  }
  const seconds = parseSeconds(value);
  return seconds === null ? null : { type: "single", seconds };
}

function formatSeconds(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function timestamps(
  start: number,
  end: number,
  requested = DEFAULT_RANGE_FRAMES,
) {
  const count = Math.min(requested, MAX_FRAMES);
  if (count <= 1) return [start];
  const interval = (end - start) / (count - 1);
  if (interval < MIN_FRAME_INTERVAL_SECONDS) {
    const values: number[] = [];
    for (
      let current = start;
      current <= end && values.length < count;
      current += MIN_FRAME_INTERVAL_SECONDS
    ) {
      values.push(current);
    }
    return values;
  }
  return Array.from({ length: count }, (_, index) =>
    Math.round(start + interval * index),
  );
}

async function extractFrames(
  media: MediaTarget,
  values: number[],
  signal?: AbortSignal,
): Promise<{ frames: VideoFrame[]; error: string | null; duration?: number }> {
  let stream: YouTubeStream | undefined;
  if (media.kind === "youtube") {
    stream = await getYouTubeStream(media.videoId as string, signal);
  }
  const results = await mapConcurrent(
    values,
    FRAME_CONCURRENCY,
    async (seconds): Promise<VideoFrame | { error: string }> => {
      const frame = stream
        ? await extractYouTubeFrame(stream.streamUrl, seconds, signal)
        : await extractLocalFrame(
            media.local?.absolutePath as string,
            seconds,
            signal,
          );
      return "error" in frame
        ? frame
        : { ...frame, timestamp: formatSeconds(seconds) };
    },
  );
  const frames = results.filter(
    (frame): frame is VideoFrame => "data" in frame,
  );
  const firstError = results.find(
    (frame): frame is { error: string } => "error" in frame,
  );
  return {
    frames,
    error:
      frames.length === 0
        ? (firstError?.error ?? "Frame extraction failed")
        : null,
    duration: stream?.duration ?? undefined,
  };
}

function frameResult(
  input: string,
  label: string,
  requested: number,
  result: Awaited<ReturnType<typeof extractFrames>>,
): ExtractedContent {
  if (result.frames.length === 0) {
    const error = result.error ?? "Frame extraction failed";
    return {
      url: input,
      title: `Frames ${label} (0/${requested})`,
      content: "",
      error,
    };
  }
  return {
    url: input,
    title: `Frames ${label} (${result.frames.length}/${requested})`,
    content: `${result.frames.length} frames extracted from ${label}`,
    error: null,
    frames: result.frames,
    duration: result.duration,
  };
}

async function mediaDuration(media: MediaTarget, signal?: AbortSignal) {
  if (media.kind === "youtube") {
    const stream = await getYouTubeStream(media.videoId as string, signal);
    if (stream.duration === null) {
      throw new Error(
        "Cannot determine video duration; provide an explicit timestamp range",
      );
    }
    return stream.duration;
  }
  return getLocalDuration(media.local?.absolutePath as string, signal);
}

async function extractRequestedFrames(
  media: MediaTarget,
  options: FetchOptions,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  if (options.frames && !options.timestamp) {
    const duration = await mediaDuration(media, signal);
    const values = timestamps(0, Math.floor(duration), options.frames);
    const label = `0:00-${formatSeconds(Math.floor(duration))}`;
    return frameResult(
      media.input,
      label,
      values.length,
      await extractFrames(media, values, signal),
    );
  }

  const spec = parseTimestamp(options.timestamp as string);
  if (!spec) throw new Error(`Invalid timestamp: ${options.timestamp}`);

  if (spec.type === "range") {
    const values = timestamps(spec.start, spec.end, options.frames);
    const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
    return frameResult(
      media.input,
      label,
      values.length,
      await extractFrames(media, values, signal),
    );
  }

  if (options.frames) {
    const end =
      spec.seconds + (options.frames - 1) * MIN_FRAME_INTERVAL_SECONDS;
    const values = timestamps(spec.seconds, end, options.frames);
    const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
    return frameResult(
      media.input,
      label,
      values.length,
      await extractFrames(media, values, signal),
    );
  }

  let frame: FrameResult;
  if (media.kind === "youtube") {
    const stream = await getYouTubeStream(media.videoId as string, signal);
    frame = await extractYouTubeFrame(stream.streamUrl, spec.seconds, signal);
  } else {
    frame = await extractLocalFrame(
      media.local?.absolutePath as string,
      spec.seconds,
      signal,
    );
  }
  if ("error" in frame) throw new Error(frame.error);
  return {
    url: media.input,
    title: `Frame at ${formatSeconds(spec.seconds)}`,
    content: `Video frame at ${formatSeconds(spec.seconds)}`,
    error: null,
    thumbnail: frame,
  };
}

async function youtubeThumbnail(
  videoId: string,
): Promise<FrameData | undefined> {
  try {
    const response = await fetch(
      `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return undefined;
    const data = Buffer.from(await response.arrayBuffer());
    return data.length > 0
      ? { data: data.toString("base64"), mimeType: "image/jpeg" }
      : undefined;
  } catch {
    return undefined;
  }
}

async function analyze(
  media: MediaTarget,
  options: FetchOptions,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  const prompt = options.prompt ?? DEFAULT_VIDEO_PROMPT;
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  if (media.kind === "youtube") {
    const result = await analyzeYouTube(
      media.input,
      media.videoId as string,
      prompt,
      model,
      signal,
    );
    result.thumbnail = await youtubeThumbnail(media.videoId as string);
    return result;
  }

  const local = media.local as VideoFile;
  const result = await analyzeLocalVideo(
    media.input,
    local,
    prompt,
    model,
    signal,
  );
  const thumbnail = await extractLocalFrame(local.absolutePath, 1, signal);
  if (!("error" in thumbnail)) result.thumbnail = thumbnail;
  return result;
}

export function isMediaInput(input: string): boolean {
  return target(input) !== null;
}

export async function extractMedia(
  input: string,
  options: FetchOptions,
  signal?: AbortSignal,
): Promise<ExtractedContent | null> {
  const media = target(input);
  if (!media) return null;
  if ("error" in media) {
    return { url: input, title: "", content: "", error: media.error };
  }

  try {
    return options.timestamp || options.frames
      ? await extractRequestedFrames(media, options, signal)
      : await analyze(media, options, signal);
  } catch (error) {
    return {
      url: input,
      title: "",
      content: "",
      error: aborted(error) ? "Aborted" : errorMessage(error),
    };
  }
}
