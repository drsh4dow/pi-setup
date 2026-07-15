import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtractedContent } from "./types.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE =
  "https://generativelanguage.googleapis.com/upload/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";

export interface VideoFile {
  absolutePath: string;
  mimeType: string;
  sizeBytes: number;
}

function key(): string {
  const value = process.env.GEMINI_API_KEY?.trim();
  if (!value) throw new Error("GEMINI_API_KEY is required for video analysis");
  return value;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function errorBody(response: Response): Promise<string> {
  return (await response.text()).replace(/\s+/g, " ").trim().slice(0, 300);
}

function title(text: string, fallback: string): string {
  const heading = text
    .match(/^#{1,2}\s+(.+)/m)?.[1]
    ?.replace(/\*+/g, "")
    .trim();
  return heading || fallback;
}

export async function queryGeminiVideo(
  prompt: string,
  videoUri: string,
  options: {
    model?: string;
    mimeType?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const fileData: Record<string, string> = { fileUri: videoUri };
  if (options.mimeType) fileData.mimeType = options.mimeType;

  const response = await fetch(
    `${GEMINI_BASE}/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key(),
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ fileData }, { text: prompt }] }],
      }),
      signal: withTimeout(options.signal, options.timeoutMs ?? 120_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Gemini API error ${response.status}: ${await errorBody(response)}`,
    );
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  const text = data.candidates?.[0]?.content?.parts
    ?.flatMap((part) => (part.text ? [part.text] : []))
    .join("\n");
  if (!text) throw new Error("Gemini API returned empty video analysis");
  return text.slice(0, 100_000);
}

async function upload(
  video: VideoFile,
  signal?: AbortSignal,
): Promise<{ name: string; uri: string }> {
  const start = await fetch(`${GEMINI_UPLOAD_BASE}/files`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(video.sizeBytes),
      "X-Goog-Upload-Header-Content-Type": video.mimeType,
      "X-Goog-Upload-Protocol": "resumable",
      "x-goog-api-key": key(),
    },
    body: JSON.stringify({
      file: { display_name: basename(video.absolutePath) },
    }),
    signal: withTimeout(signal, 180_000),
  });
  if (!start.ok) {
    throw new Error(
      `Gemini upload initialization failed ${start.status}: ${await errorBody(start)}`,
    );
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini returned no video upload URL");

  const result = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(video.sizeBytes),
      "X-Goog-Upload-Command": "upload, finalize",
      "X-Goog-Upload-Offset": "0",
    },
    body: await readFile(video.absolutePath),
    signal: withTimeout(signal, 180_000),
  });
  if (!result.ok) {
    throw new Error(
      `Gemini video upload failed ${result.status}: ${await errorBody(result)}`,
    );
  }
  const data = (await result.json()) as {
    file?: { name?: string; uri?: string };
  };
  if (!data.file?.name || !data.file.uri) {
    throw new Error("Gemini returned an invalid video upload response");
  }
  return { name: data.file.name, uri: data.file.uri };
}

async function waitUntilActive(
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${GEMINI_BASE}/${name}`, {
      headers: { "x-goog-api-key": key() },
      signal: withTimeout(signal, 15_000),
    });
    if (!response.ok) {
      throw new Error(`Gemini file-state check failed ${response.status}`);
    }
    const data = (await response.json()) as { state?: string };
    if (data.state === "ACTIVE") return;
    if (data.state === "FAILED")
      throw new Error("Gemini video processing failed");
    await delay(5_000, undefined, { signal });
  }
  throw new Error("Gemini video processing timed out");
}

async function remove(name: string): Promise<void> {
  try {
    const response = await fetch(`${GEMINI_BASE}/${name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": key() },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error(
        `Failed to delete Gemini upload ${name}: HTTP ${response.status}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to delete Gemini upload ${name}: ${message}`);
  }
}

export async function analyzeYouTube(
  input: string,
  videoId: string,
  prompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  const content = await queryGeminiVideo(
    prompt,
    `https://www.youtube.com/watch?v=${videoId}`,
    { model, signal },
  );
  return {
    url: input,
    title: title(content, "YouTube Video"),
    content,
    error: null,
  };
}

export async function analyzeLocalVideo(
  input: string,
  video: VideoFile,
  prompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  const uploaded = await upload(video, signal);
  try {
    await waitUntilActive(uploaded.name, signal);
    const content = await queryGeminiVideo(prompt, uploaded.uri, {
      mimeType: video.mimeType,
      model,
      signal,
    });
    return {
      url: input,
      title: title(content, basename(video.absolutePath)),
      content,
      error: null,
    };
  } finally {
    await remove(uploaded.name);
  }
}
