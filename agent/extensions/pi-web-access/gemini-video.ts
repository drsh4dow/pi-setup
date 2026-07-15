import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Effect } from "effect";
import {
  asError,
  errorMessage,
  type WebAccessError,
  webAccessError,
} from "./errors.ts";
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
  if (!value)
    throw webAccessError("GEMINI_API_KEY is required for video analysis");
  return value;
}

function errorBody(response: Response): Effect.Effect<string, WebAccessError> {
  return Effect.tryPromise({ try: () => response.text(), catch: asError }).pipe(
    Effect.map((body) => body.replace(/\s+/g, " ").trim().slice(0, 300)),
  );
}

function title(text: string, fallback: string): string {
  const heading = text
    .match(/^#{1,2}\s+(.+)/m)?.[1]
    ?.replace(/\*+/g, "")
    .trim();
  return heading || fallback;
}

export function queryGeminiVideo(
  prompt: string,
  videoUri: string,
  options: {
    model?: string;
    mimeType?: string;
    timeoutMs?: number;
  } = {},
): Effect.Effect<string, WebAccessError> {
  return Effect.gen(function* () {
    const model = options.model ?? DEFAULT_GEMINI_MODEL;
    const fileData: Record<string, string> = { fileUri: videoUri };
    if (options.mimeType) fileData.mimeType = options.mimeType;

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key(),
          },
          body: JSON.stringify({
            contents: [
              { role: "user", parts: [{ fileData }, { text: prompt }] },
            ],
          }),
          signal,
        }),
      catch: asError,
    }).pipe(
      Effect.timeout(options.timeoutMs ?? 120_000),
      Effect.mapError(asError),
    );
    if (!response.ok) {
      return yield* webAccessError(
        `Gemini API error ${response.status}: ${yield* errorBody(response)}`,
      );
    }

    const data = yield* Effect.tryPromise({
      try: () =>
        response.json() as Promise<{
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        }>,
      catch: asError,
    });
    const text = data.candidates?.[0]?.content?.parts
      ?.flatMap((part) => (part.text ? [part.text] : []))
      .join("\n");
    return text
      ? text.slice(0, 100_000)
      : yield* webAccessError("Gemini API returned empty video analysis");
  });
}

function upload(
  video: VideoFile,
): Effect.Effect<{ name: string; uri: string }, WebAccessError> {
  return Effect.gen(function* () {
    const start = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${GEMINI_UPLOAD_BASE}/files`, {
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
          signal,
        }),
      catch: asError,
    }).pipe(Effect.timeout(180_000), Effect.mapError(asError));
    if (!start.ok) {
      return yield* webAccessError(
        `Gemini upload initialization failed ${start.status}: ${yield* errorBody(start)}`,
      );
    }
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      return yield* webAccessError("Gemini returned no video upload URL");
    }

    const body = yield* Effect.tryPromise({
      try: () => readFile(video.absolutePath),
      catch: asError,
    });
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(video.sizeBytes),
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": "0",
          },
          body,
          signal,
        }),
      catch: asError,
    }).pipe(Effect.timeout(180_000), Effect.mapError(asError));
    if (!result.ok) {
      return yield* webAccessError(
        `Gemini video upload failed ${result.status}: ${yield* errorBody(result)}`,
      );
    }
    const data = yield* Effect.tryPromise({
      try: () =>
        result.json() as Promise<{ file?: { name?: string; uri?: string } }>,
      catch: asError,
    });
    return data.file?.name && data.file.uri
      ? { name: data.file.name, uri: data.file.uri }
      : yield* webAccessError(
          "Gemini returned an invalid video upload response",
        );
  });
}

function waitUntilActive(name: string): Effect.Effect<void, WebAccessError> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${GEMINI_BASE}/${name}`, {
            headers: { "x-goog-api-key": key() },
            signal,
          }),
        catch: asError,
      }).pipe(Effect.timeout(15_000), Effect.mapError(asError));
      if (!response.ok) {
        return yield* webAccessError(
          `Gemini file-state check failed ${response.status}`,
        );
      }
      const data = yield* Effect.tryPromise({
        try: () => response.json() as Promise<{ state?: string }>,
        catch: asError,
      });
      if (data.state === "ACTIVE") return;
      if (data.state === "FAILED") {
        return yield* webAccessError("Gemini video processing failed");
      }
      yield* Effect.sleep(5_000);
    }
    return yield* webAccessError("Gemini video processing timed out");
  }).pipe(Effect.timeout(120_000), Effect.mapError(asError));
}

function remove(name: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${GEMINI_BASE}/${name}`, {
          method: "DELETE",
          headers: { "x-goog-api-key": key() },
          signal,
        }),
      catch: asError,
    }).pipe(Effect.timeout(15_000), Effect.mapError(asError));
    if (!response.ok) {
      console.error(
        `Failed to delete Gemini upload ${name}: HTTP ${response.status}`,
      );
    }
  }).pipe(
    Effect.catch((error) => {
      console.error(
        `Failed to delete Gemini upload ${name}: ${errorMessage(error)}`,
      );
      return Effect.void;
    }),
  );
}

export function analyzeYouTube(
  input: string,
  videoId: string,
  prompt: string,
  model: string,
): Effect.Effect<ExtractedContent, WebAccessError> {
  return queryGeminiVideo(
    prompt,
    `https://www.youtube.com/watch?v=${videoId}`,
    { model },
  ).pipe(
    Effect.map((content) => ({
      url: input,
      title: title(content, "YouTube Video"),
      content,
      error: null,
    })),
  );
}

export function analyzeLocalVideo(
  input: string,
  video: VideoFile,
  prompt: string,
  model: string,
): Effect.Effect<ExtractedContent, WebAccessError> {
  return Effect.acquireUseRelease(
    upload(video),
    (uploaded) =>
      Effect.gen(function* () {
        yield* waitUntilActive(uploaded.name);
        const content = yield* queryGeminiVideo(prompt, uploaded.uri, {
          mimeType: video.mimeType,
          model,
        });
        return {
          url: input,
          title: title(content, basename(video.absolutePath)),
          content,
          error: null,
        };
      }),
    (uploaded) => remove(uploaded.name),
  );
}
