import { mapConcurrent } from "./concurrency.ts";
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

async function specializedContent(
  url: string,
  options: FetchOptions,
  signal?: AbortSignal,
): Promise<ExtractedContent> {
  try {
    if (isMediaInput(url)) {
      return (
        (await extractMedia(url, options, signal)) ??
        itemError(url, "Unsupported media input")
      );
    }
    if (options.timestamp || options.frames) {
      return itemError(
        url,
        "Frame extraction only supports YouTube URLs and local video files",
      );
    }
    return (
      (await extractGitHub(url, signal, options.forceClone)) ??
      itemError(url, "GitHub extraction failed")
    );
  } catch (error) {
    return itemError(
      url,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function fetchContent(
  urls: string[],
  options: FetchOptions,
  signal?: AbortSignal,
): Promise<ExtractedContent[]> {
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
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        results[index] = itemError(
          url,
          "Only HTTP and HTTPS URLs are supported",
        );
      } else {
        ordinary.push({ url, index });
      }
    } catch {
      results[index] = itemError(url, "Invalid URL or unsupported local file");
    }
  }

  const ordinaryPromise = ordinary.length
    ? fetchExaContents(
        ordinary.map((item) => item.url),
        signal,
      ).then(
        (items) => {
          for (const [position, item] of items.entries()) {
            results[ordinary[position].index] = item;
          }
        },
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          for (const item of ordinary) {
            results[item.index] = itemError(item.url, message);
          }
        },
      )
    : Promise.resolve();

  const specializedPromise = mapConcurrent(specialized, 2, async (item) => {
    results[item.index] = await specializedContent(item.url, options, signal);
  });

  await Promise.all([ordinaryPromise, specializedPromise]);
  return results;
}
