import { Effect } from "effect";
import { asError, errorMessage } from "./errors.ts";
import { fetchExaContents } from "./exa.ts";
import { extractGitHub, parseGitHubUrl } from "./github.ts";
import { extractMedia, isMediaInput, parseTimestamp } from "./media.ts";
import type { ExtractedContent, FetchOptions } from "./types.ts";

const MAX_URLS = 10;
const MAX_URL_LENGTH = 8_192;
const MAX_PROMPT_LENGTH = 10_000;
const MAX_MODEL_LENGTH = 200;
const MAX_FRAMES = 12;

export interface RawFetchParams {
  url?: unknown;
  urls?: unknown;
  forceClone?: unknown;
  prompt?: unknown;
  timestamp?: unknown;
  frames?: unknown;
  model?: unknown;
}

export type NormalizedFetchParams =
  | { urls: string[]; options: FetchOptions; error?: undefined }
  | { urls?: undefined; options?: undefined; error: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeFetchParams(
  params: RawFetchParams,
): NormalizedFetchParams {
  if (
    Array.isArray(params.urls) &&
    params.urls.some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    )
  ) {
    return { error: "Every URL must be a non-empty string" };
  }
  const plural = Array.isArray(params.urls)
    ? params.urls.map((value) => (value as string).trim())
    : [];
  const single = optionalString(params.url);
  const urls = [
    ...new Set(plural.length > 0 ? plural : single ? [single] : []),
  ];
  if (urls.length === 0) return { error: "Provide url or urls" };
  if (urls.length > MAX_URLS) {
    return { error: `fetch_content accepts at most ${MAX_URLS} URLs` };
  }
  const oversizedUrl = urls.find((url) => url.length > MAX_URL_LENGTH);
  if (oversizedUrl) {
    return { error: `URL or path exceeds ${MAX_URL_LENGTH} characters` };
  }

  const prompt = optionalString(params.prompt);
  if (prompt && prompt.length > MAX_PROMPT_LENGTH) {
    return { error: `Video prompt exceeds ${MAX_PROMPT_LENGTH} characters` };
  }
  const model = optionalString(params.model);
  if (model && model.length > MAX_MODEL_LENGTH) {
    return { error: `Model ID exceeds ${MAX_MODEL_LENGTH} characters` };
  }
  if (model && !/^[a-zA-Z0-9._/-]+$/.test(model)) {
    return { error: "Model ID contains unsupported characters" };
  }

  const timestamp = optionalString(params.timestamp);
  if (timestamp && !parseTimestamp(timestamp)) {
    return {
      error: "Invalid timestamp; use seconds, H:MM:SS, MM:SS, or start-end",
    };
  }
  if (
    params.frames !== undefined &&
    (typeof params.frames !== "number" ||
      !Number.isInteger(params.frames) ||
      params.frames < 1 ||
      params.frames > MAX_FRAMES)
  ) {
    return { error: `frames must be an integer from 1 to ${MAX_FRAMES}` };
  }
  const frames =
    typeof params.frames === "number" &&
    (timestamp !== undefined || params.frames > 1)
      ? params.frames
      : undefined;

  return {
    urls,
    options: {
      forceClone:
        typeof params.forceClone === "boolean" ? params.forceClone : undefined,
      prompt,
      timestamp,
      frames,
      model,
    },
  };
}

function itemError(url: string, error: string): ExtractedContent {
  return { url, title: "", content: "", error };
}

function specializedContent(
  url: string,
  options: FetchOptions,
): Effect.Effect<ExtractedContent> {
  if (isMediaInput(url)) {
    return extractMedia(url, options).pipe(
      Effect.map((item) => item ?? itemError(url, "Unsupported media input")),
    );
  }
  if (options.timestamp || options.frames) {
    return Effect.succeed(
      itemError(
        url,
        "Frame extraction only supports YouTube URLs and local video files",
      ),
    );
  }
  return extractGitHub(url, options.forceClone).pipe(
    Effect.map((item) => item ?? itemError(url, "GitHub extraction failed")),
    Effect.catch((error) =>
      Effect.succeed(itemError(url, errorMessage(error))),
    ),
  );
}

export function fetchContent(
  urls: string[],
  options: FetchOptions,
): Effect.Effect<ExtractedContent[]> {
  return Effect.gen(function* () {
    const results = Array<ExtractedContent>(urls.length);
    const ordinary: Array<{ url: string; index: number }> = [];
    const specialized: Array<{ url: string; index: number }> = [];

    for (const [index, url] of urls.entries()) {
      if (parseGitHubUrl(url) || isMediaInput(url)) {
        specialized.push({ url, index });
        continue;
      }
      if (options.timestamp || options.frames) {
        results[index] = itemError(
          url,
          "Frame extraction only supports YouTube URLs and local video files",
        );
        continue;
      }
      const parsed = yield* Effect.try({
        try: () => new URL(url),
        catch: asError,
      }).pipe(Effect.orElseSucceed(() => null));
      if (!parsed) {
        results[index] = itemError(
          url,
          "Invalid URL or unsupported local file",
        );
      } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        results[index] = itemError(
          url,
          "Only HTTP and HTTPS URLs are supported",
        );
      } else {
        ordinary.push({ url, index });
      }
    }

    const ordinaryEffect = ordinary.length
      ? fetchExaContents(ordinary.map((item) => item.url)).pipe(
          Effect.map((items) =>
            items.map((content, position) => ({
              index: ordinary[position].index,
              content,
            })),
          ),
          Effect.catch((error) =>
            Effect.succeed(
              ordinary.map((item) => ({
                index: item.index,
                content: itemError(item.url, errorMessage(error)),
              })),
            ),
          ),
        )
      : Effect.succeed([]);
    const specializedEffect = Effect.forEach(
      specialized,
      (item) =>
        specializedContent(item.url, options).pipe(
          Effect.map((content) => ({ index: item.index, content })),
        ),
      { concurrency: 2 },
    );

    const groups = yield* Effect.all([ordinaryEffect, specializedEffect], {
      concurrency: 2,
    });
    for (const group of groups) {
      for (const item of group) results[item.index] = item.content;
    }
    return results;
  });
}
