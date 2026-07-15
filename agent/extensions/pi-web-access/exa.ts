import { Effect } from "effect";
import { asError } from "./errors.ts";
import type {
  ExtractedContent,
  SearchOptions,
  SearchResult,
  SearchSource,
} from "./types.ts";

const API_BASE = "https://api.exa.ai";
const REQUEST_TIMEOUT_MS = 60_000;
const SEARCH_CONTENT_CHARS = 20_000;
const FETCH_CONTENT_CHARS = 100_000;

interface ExaResult {
  id?: string;
  url?: string;
  title?: string;
  text?: string;
  highlights?: unknown;
}

interface ExaAnswerResponse {
  answer?: string | Record<string, unknown>;
  citations?: ExaResult[];
}

interface ExaSearchResponse {
  results?: ExaResult[];
}

interface ExaContentsResponse {
  results?: ExaResult[];
  statuses?: Array<{
    id?: string;
    status?: string;
    error?: { tag?: string; message?: string } | string;
  }>;
}

function apiKey(): string {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "EXA_API_KEY is required for Exa search and URL extraction",
    );
  }
  return key;
}

function post<T>(
  path: string,
  body: Record<string, unknown>,
): Effect.Effect<T, Error> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${API_BASE}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey(),
          },
          body: JSON.stringify(body),
          signal,
        }),
      catch: asError,
    }).pipe(Effect.timeout(REQUEST_TIMEOUT_MS), Effect.mapError(asError));

    if (!response.ok) {
      const detail = (yield* Effect.tryPromise({
        try: () => response.text(),
        catch: asError,
      }))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      return yield* Effect.fail(
        new Error(
          `Exa API error ${response.status}${detail ? `: ${detail}` : ""}`,
        ),
      );
    }

    return yield* Effect.tryPromise({
      try: () => response.json() as Promise<T>,
      catch: asError,
    });
  });
}

function highlights(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function source(result: ExaResult, index: number): SearchSource | null {
  const url = result.url ?? result.id;
  if (!url) return null;
  return {
    title: result.title?.trim() || `Source ${index + 1}`,
    url,
    snippet: (
      highlights(result.highlights).join(" ") ||
      result.text?.trim() ||
      ""
    ).slice(0, 1_000),
  };
}

function sources(results: ExaResult[] | undefined): SearchSource[] {
  return (results ?? []).flatMap((result, index) => {
    const mapped = source(result, index);
    return mapped ? [mapped] : [];
  });
}

function evidence(results: ExaResult[] | undefined): string {
  return (results ?? [])
    .flatMap((result, index) => {
      const mapped = source(result, index);
      if (!mapped) return [];
      const text =
        highlights(result.highlights).join(" ") || result.text?.trim();
      return text
        ? [`${text.slice(0, 4_000)}\nSource: ${mapped.title} (${mapped.url})`]
        : [];
    })
    .join("\n\n");
}

function inlineContent(results: ExaResult[] | undefined): ExtractedContent[] {
  return (results ?? []).flatMap((result) => {
    const url = result.url ?? result.id;
    if (!url || !result.text) return [];
    return [
      {
        url,
        title: result.title?.trim() || url,
        content: result.text.slice(0, SEARCH_CONTENT_CHARS),
        error: null,
      },
    ];
  });
}

function startPublishedDate(
  filter: NonNullable<SearchOptions["recencyFilter"]>,
) {
  const days = { day: 1, week: 7, month: 30, year: 365 }[filter];
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function domainFilters(domains: string[] | undefined) {
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];
  for (const domain of domains ?? []) {
    if (domain.startsWith("-")) excludeDomains.push(domain.slice(1));
    else includeDomains.push(domain);
  }
  return {
    ...(includeDomains.length > 0 ? { includeDomains } : {}),
    ...(excludeDomains.length > 0 ? { excludeDomains } : {}),
  };
}

export function searchExa(
  query: string,
  options: SearchOptions = {},
): Effect.Effect<SearchResult, Error> {
  return Effect.gen(function* () {
    const useSearch =
      options.includeContent === true ||
      options.recencyFilter !== undefined ||
      (options.domainFilter?.length ?? 0) > 0 ||
      options.numResults !== undefined;

    if (!useSearch) {
      const response = yield* post<ExaAnswerResponse>("/answer", {
        query,
        text: true,
      });
      const answer =
        typeof response.answer === "string"
          ? response.answer
          : response.answer
            ? JSON.stringify(response.answer)
            : "";
      return {
        answer: answer.slice(0, FETCH_CONTENT_CHARS),
        sources: sources(response.citations),
        content: [],
      };
    }

    const response = yield* post<ExaSearchResponse>("/search", {
      query,
      type: "auto",
      numResults: options.numResults ?? 5,
      ...domainFilters(options.domainFilter),
      ...(options.recencyFilter
        ? { startPublishedDate: startPublishedDate(options.recencyFilter) }
        : {}),
      contents: {
        highlights: { maxCharacters: 4_000 },
        ...(options.includeContent
          ? { text: { maxCharacters: SEARCH_CONTENT_CHARS } }
          : {}),
      },
    });

    return {
      answer: evidence(response.results),
      sources: sources(response.results),
      content: options.includeContent ? inlineContent(response.results) : [],
    };
  });
}

function statusError(
  statuses: ExaContentsResponse["statuses"],
  url: string,
): string | null {
  const status = statuses?.find((item) => item.id === url);
  if (status?.status !== "error") return null;
  if (typeof status.error === "string") return status.error;
  return (
    status.error?.message ||
    status.error?.tag ||
    "Exa could not extract this URL"
  );
}

export function fetchExaContents(
  urls: string[],
): Effect.Effect<ExtractedContent[], Error> {
  return Effect.gen(function* () {
    const response = yield* post<ExaContentsResponse>("/contents", {
      urls,
      text: { maxCharacters: FETCH_CONTENT_CHARS },
      livecrawlTimeout: 15_000,
    });
    const results = response.results ?? [];
    const canonical = (url: string) => {
      try {
        return new URL(url).href;
      } catch {
        return url;
      }
    };
    const byUrl = new Map<string, ExaResult>();
    for (const result of results) {
      if (result.url) byUrl.set(canonical(result.url), result);
      if (result.id) byUrl.set(canonical(result.id), result);
    }

    return urls.map((url) => {
      const result = byUrl.get(canonical(url));
      const error = statusError(response.statuses, url);
      if (!result?.text) {
        const message =
          error ?? "Exa returned no readable content for this URL";
        return { url, title: result?.title ?? "", content: "", error: message };
      }
      return {
        url,
        title: result.title?.trim() || url,
        content: result.text.slice(0, FETCH_CONTENT_CHARS),
        error: null,
      };
    });
  });
}
