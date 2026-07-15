import { Effect } from "effect";
import { errorMessage } from "./errors.ts";
import { runCommand } from "./subprocess.ts";
import type { FrameResult } from "./types.ts";

export interface YouTubeStream {
  streamUrl: string;
  duration: number | null;
}

function processError(
  tool: "ffmpeg" | "ffprobe" | "yt-dlp",
  error: unknown,
): string {
  const item = error as {
    code?: string;
    killed?: boolean;
    stderr?: Buffer | string;
    message?: string;
  };
  if (item.code === "ABORT_ERR") return "Aborted";
  if (item.code === "ENOENT") return `${tool} is not installed`;
  if (item.killed || item.code === "ETIMEDOUT") return `${tool} timed out`;
  const stderr = Buffer.isBuffer(item.stderr)
    ? item.stderr.toString("utf8")
    : (item.stderr ?? "");
  const detail = (stderr || item.message || errorMessage(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return detail ? `${tool} failed: ${detail}` : `${tool} failed`;
}

export function getYouTubeStream(
  videoId: string,
): Effect.Effect<YouTubeStream, Error> {
  return Effect.gen(function* () {
    const output = yield* runCommand(
      "yt-dlp",
      [
        "--print",
        "duration",
        "-g",
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { timeoutMs: 15_000, maxBuffer: 5 * 1024 * 1024 },
    ).pipe(
      Effect.mapError((error) => new Error(processError("yt-dlp", error))),
    );
    const lines = output.toString("utf8").trim().split(/\r?\n/);
    const streamUrl = lines[1]?.trim();
    if (!streamUrl)
      return yield* Effect.fail(new Error("yt-dlp returned no stream URL"));
    const duration = Number.parseFloat(lines[0] ?? "");
    return {
      streamUrl,
      duration: Number.isFinite(duration) ? duration : null,
    };
  });
}

function extractFrame(
  input: string,
  seconds: number,
  timeoutMs: number,
): Effect.Effect<FrameResult> {
  return runCommand(
    "ffmpeg",
    [
      "-v",
      "error",
      "-ss",
      String(seconds),
      "-i",
      input,
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ],
    { timeoutMs, maxBuffer: 5 * 1024 * 1024 },
  ).pipe(
    Effect.map(
      (output): FrameResult =>
        output.length > 0
          ? { data: output.toString("base64"), mimeType: "image/jpeg" }
          : { error: "ffmpeg returned an empty frame" },
    ),
    Effect.catch((error) =>
      Effect.succeed({ error: processError("ffmpeg", error) }),
    ),
  );
}

export function extractYouTubeFrame(
  streamUrl: string,
  seconds: number,
): Effect.Effect<FrameResult> {
  return extractFrame(streamUrl, seconds, 30_000);
}

export function extractLocalFrame(
  path: string,
  seconds: number,
): Effect.Effect<FrameResult> {
  return extractFrame(path, seconds, 10_000);
}

export function getLocalDuration(path: string): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const output = yield* runCommand(
      "ffprobe",
      [
        "-v",
        "quiet",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        path,
      ],
      { timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
    ).pipe(
      Effect.mapError((error) => new Error(processError("ffprobe", error))),
    );
    const duration = Number.parseFloat(output.toString("utf8").trim());
    return Number.isFinite(duration)
      ? duration
      : yield* Effect.fail(
          new Error("ffprobe failed: invalid duration output"),
        );
  });
}
