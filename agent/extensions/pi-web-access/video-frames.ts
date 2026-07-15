import { execFile } from "node:child_process";
import type { FrameResult } from "./types.ts";

export interface YouTubeStream {
  streamUrl: string;
  duration: number | null;
}

function aborted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("abort");
}

async function run(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxBuffer: number;
    signal?: AbortSignal;
  },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr });
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8"));
      },
    );
  });
}

function processError(
  tool: "ffmpeg" | "ffprobe" | "yt-dlp",
  error: unknown,
): string {
  if (aborted(error)) return "Aborted";
  const item = error as {
    code?: string;
    killed?: boolean;
    stderr?: Buffer | string;
    message?: string;
  };
  if (item.code === "ENOENT") return `${tool} is not installed`;
  if (item.killed || item.code === "ETIMEDOUT") return `${tool} timed out`;
  const stderr = Buffer.isBuffer(item.stderr)
    ? item.stderr.toString("utf8")
    : (item.stderr ?? "");
  const detail = (stderr || item.message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return detail ? `${tool} failed: ${detail}` : `${tool} failed`;
}

export async function getYouTubeStream(
  videoId: string,
  signal?: AbortSignal,
): Promise<YouTubeStream> {
  try {
    const output = (
      await run(
        "yt-dlp",
        [
          "--print",
          "duration",
          "-g",
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        { timeoutMs: 15_000, maxBuffer: 5 * 1024 * 1024, signal },
      )
    )
      .toString("utf8")
      .trim()
      .split(/\r?\n/);
    const streamUrl = output[1]?.trim();
    if (!streamUrl) throw new Error("yt-dlp returned no stream URL");
    const duration = Number.parseFloat(output[0] ?? "");
    return {
      streamUrl,
      duration: Number.isFinite(duration) ? duration : null,
    };
  } catch (error) {
    throw new Error(processError("yt-dlp", error));
  }
}

export async function extractYouTubeFrame(
  streamUrl: string,
  seconds: number,
  signal?: AbortSignal,
): Promise<FrameResult> {
  try {
    const output = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(seconds),
        "-i",
        streamUrl,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { timeoutMs: 30_000, maxBuffer: 5 * 1024 * 1024, signal },
    );
    return output.length > 0
      ? { data: output.toString("base64"), mimeType: "image/jpeg" }
      : { error: "ffmpeg returned an empty frame" };
  } catch (error) {
    return { error: processError("ffmpeg", error) };
  }
}

export async function extractLocalFrame(
  path: string,
  seconds: number,
  signal?: AbortSignal,
): Promise<FrameResult> {
  try {
    const output = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-ss",
        String(seconds),
        "-i",
        path,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      { timeoutMs: 10_000, maxBuffer: 5 * 1024 * 1024, signal },
    );
    return output.length > 0
      ? { data: output.toString("base64"), mimeType: "image/jpeg" }
      : { error: "ffmpeg returned an empty frame" };
  } catch (error) {
    return { error: processError("ffmpeg", error) };
  }
}

export async function getLocalDuration(
  path: string,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const output = (
      await run(
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
        { timeoutMs: 10_000, maxBuffer: 1024 * 1024, signal },
      )
    )
      .toString("utf8")
      .trim();
    const duration = Number.parseFloat(output);
    if (!Number.isFinite(duration)) throw new Error("invalid duration output");
    return duration;
  } catch (error) {
    throw new Error(processError("ffprobe", error));
  }
}
