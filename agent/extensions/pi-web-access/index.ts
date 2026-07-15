import { type Static, StringEnum, Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { searchExa } from "./exa.ts";
import {
  fetchContent,
  normalizeFetchParams,
  type RawFetchParams,
} from "./fetch-content.ts";
import { clearCloneCache } from "./github.ts";
import {
  createResponseId,
  getResponse,
  initializeStorage,
  storeResponse,
} from "./storage.ts";
import type {
  ExtractedContent,
  SearchOptions,
  StoredResponse,
  StoredSearchItem,
} from "./types.ts";

const MAX_QUERIES = 4;
const MAX_QUERY_LENGTH = 2_000;
const MAX_DOMAINS = 20;
const INITIAL_FETCH_CHARS = 30_000;

const SearchParams = Type.Object({
  query: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: MAX_QUERY_LENGTH,
      description: "One search query. Prefer queries for broad research.",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }), {
      minItems: 1,
      maxItems: MAX_QUERIES,
      description: "Up to four varied queries, executed sequentially.",
    }),
  ),
  numResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 20,
      description: "Results per query. Defaults to 5.",
    }),
  ),
  includeContent: Type.Optional(
    Type.Boolean({
      description: "Store up to 20,000 characters from each search result.",
    }),
  ),
  recencyFilter: Type.Optional(
    StringEnum(["day", "week", "month", "year"], {
      description: "Only include recently published results.",
    }),
  ),
  domainFilter: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 253 }), {
      maxItems: MAX_DOMAINS,
      description: "Include domains; prefix exclusions with a minus sign.",
    }),
  ),
});

type SearchParams = Static<typeof SearchParams>;

const FetchParams = Type.Object({
  url: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 8_192,
      description:
        "One HTTP URL, GitHub URL, YouTube URL, or local video path.",
    }),
  ),
  urls: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 8_192 }), {
      minItems: 1,
      maxItems: 10,
      description: "Up to ten URLs or local video paths.",
    }),
  ),
  forceClone: Type.Optional(
    Type.Boolean({
      description: "Bypass the 350 MB GitHub automatic-clone threshold.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 10_000,
      description: "Question or instruction for video analysis.",
    }),
  ),
  timestamp: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 100,
      description: "Video timestamp or range, such as 1:23 or 1:00-1:30.",
    }),
  ),
  frames: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 12,
      description: "Frames to sample from a video. Maximum 12.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Gemini model override for video analysis.",
    }),
  ),
});

const GetContentParams = Type.Object({
  responseId: Type.String({
    minLength: 1,
    maxLength: 100,
    description: "Response ID returned by web_search or fetch_content.",
  }),
  itemIndex: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 9,
      description: "Optional zero-based query or URL index.",
    }),
  ),
});

interface SearchDetails {
  responseId?: string;
  itemCount: number;
  successful: number;
  error?: string;
  cacheError?: string;
}

interface FetchDetails {
  responseId?: string;
  itemCount: number;
  successful: number;
  error?: string;
  cacheError?: string;
}

interface GetContentDetails {
  responseId: string;
  itemCount: number;
  itemIndex?: number;
  error?: string;
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function normalizeSearch(
  params: SearchParams,
):
  | { queries: string[]; options: SearchOptions; error?: undefined }
  | { queries?: undefined; options?: undefined; error: string } {
  const rawQueries = params.queries?.length
    ? params.queries
    : params.query
      ? [params.query]
      : [];
  if (rawQueries.length === 0) return { error: "Provide query or queries" };
  if (rawQueries.length > MAX_QUERIES) {
    return { error: `web_search accepts at most ${MAX_QUERIES} queries` };
  }

  const queries: string[] = [];
  for (const query of rawQueries) {
    if (typeof query !== "string" || !query.trim()) {
      return { error: "Every query must be a non-empty string" };
    }
    const normalized = query.trim();
    if (normalized.length > MAX_QUERY_LENGTH) {
      return { error: `Queries may not exceed ${MAX_QUERY_LENGTH} characters` };
    }
    if (!queries.includes(normalized)) queries.push(normalized);
  }

  if (
    params.numResults !== undefined &&
    (!Number.isInteger(params.numResults) ||
      params.numResults < 1 ||
      params.numResults > 20)
  ) {
    return { error: "numResults must be an integer from 1 to 20" };
  }

  const domainFilter: string[] = [];
  if (params.domainFilter !== undefined) {
    if (
      !Array.isArray(params.domainFilter) ||
      params.domainFilter.length > MAX_DOMAINS
    ) {
      return { error: `domainFilter accepts at most ${MAX_DOMAINS} domains` };
    }
    for (const domain of params.domainFilter) {
      if (typeof domain !== "string" || !domain.trim()) {
        return { error: "Every domain filter must be a non-empty string" };
      }
      const normalized = domain.trim();
      if (normalized === "-" || normalized.replace(/^-/, "").length > 253) {
        return { error: `Invalid domain filter: ${normalized}` };
      }
      if (!domainFilter.includes(normalized)) domainFilter.push(normalized);
    }
  }

  const recency = params.recencyFilter as SearchOptions["recencyFilter"];
  if (
    recency !== undefined &&
    !["day", "week", "month", "year"].includes(recency)
  ) {
    return { error: "Invalid recencyFilter" };
  }

  return {
    queries,
    options: {
      numResults: params.numResults,
      includeContent: params.includeContent,
      recencyFilter: recency,
      domainFilter,
    },
  };
}

function formatSources(item: StoredSearchItem): string {
  return item.sources.length === 0
    ? ""
    : `\n\nSources:\n${item.sources
        .map((source) => `- [${source.title}](${source.url})`)
        .join("\n")}`;
}

function formatSearchItem(
  item: StoredSearchItem,
  includeContent: boolean,
): string {
  if (item.error) return `## ${item.query}\n\nError: ${item.error}`;
  const fullContent =
    includeContent && item.content.length > 0
      ? `\n\nRetrieved content:\n${item.content
          .map(
            (content) =>
              `\n### ${content.title || content.url}\n${content.error ? `Error: ${content.error}` : content.content}`,
          )
          .join("\n")}`
      : "";
  return `## ${item.query}\n\n${item.answer || "No answer returned."}${formatSources(item)}${fullContent}`;
}

function formatFetchedItem(item: ExtractedContent, initial: boolean): string {
  const heading = item.title || item.url;
  if (item.error) return `## ${heading}\n\nError: ${item.error}`;
  const content = initial
    ? item.content.slice(0, INITIAL_FETCH_CHARS)
    : item.content;
  const truncated =
    initial && item.content.length > INITIAL_FETCH_CHARS
      ? `\n\n[Showing ${INITIAL_FETCH_CHARS} of ${item.content.length} characters. Use get_search_content for the stored text.]`
      : "";
  return `## ${heading}\n\n${content}${truncated}`;
}

function textOnly(item: ExtractedContent): ExtractedContent {
  return {
    url: item.url,
    title: item.title,
    content: item.content.slice(0, 100_000),
    error: item.error,
    duration: item.duration,
  };
}

async function cacheResponse(
  response: StoredResponse,
): Promise<string | undefined> {
  try {
    await storeResponse(response);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export default function webAccessExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, context) => {
    try {
      await initializeStorage(context.sessionManager.getSessionId());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[pi-web-access] Could not initialize response storage: ${message}`,
      );
    }
  });

  pi.on("session_shutdown", () => {
    clearCloneCache();
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web with Exa. Default searches return a grounded answer with citations; count, recency, domain, or content options use Exa search evidence. Accepts up to four sequential queries. Requires EXA_API_KEY.",
    promptSnippet:
      "Use for web research. Prefer 2-4 genuinely varied queries for broad questions.",
    parameters: SearchParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      const normalized = normalizeSearch(params);
      if ("error" in normalized) {
        return textResult<SearchDetails>(`Error: ${normalized.error}`, {
          itemCount: 0,
          successful: 0,
          error: normalized.error,
        });
      }

      const items: StoredSearchItem[] = [];
      for (const [index, query] of normalized.queries.entries()) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Searching ${index + 1}/${normalized.queries.length}: ${query}`,
            },
          ],
          details: { index, query },
        });
        try {
          const result = await searchExa(query, {
            ...normalized.options,
            signal,
          });
          items.push({ query, ...result, error: null });
        } catch (error) {
          items.push({
            query,
            answer: "",
            sources: [],
            content: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const responseId = createResponseId();
      const cacheError = await cacheResponse({
        id: responseId,
        type: "search",
        timestamp: Date.now(),
        items,
      });
      const successful = items.filter((item) => item.error === null).length;
      const output = [
        ...items.map((item) => formatSearchItem(item, false)),
        `Response ID: ${responseId}`,
        ...(cacheError ? [`Cache error: ${cacheError}`] : []),
      ].join("\n\n---\n\n");
      return textResult<SearchDetails>(output, {
        responseId,
        itemCount: items.length,
        successful,
        ...(successful === 0 ? { error: "All searches failed" } : {}),
        ...(cacheError ? { cacheError } : {}),
      });
    },
    renderCall(args, theme) {
      const count = args.queries?.length ?? (args.query ? 1 : 0);
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("muted", `${count} quer${count === 1 ? "y" : "ies"}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as SearchDetails | undefined;
      if (!details) return new Text("Search finished", 0, 0);
      const text = `${details.successful}/${details.itemCount} searches • ${details.responseId ?? details.error ?? "no response"}`;
      return new Text(
        theme.fg(details.successful > 0 ? "success" : "error", text),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description:
      "Fetch up to ten URLs. Exa extracts ordinary web pages and PDFs; GitHub URLs support API views and shallow clones; YouTube and local videos support Gemini analysis and frame extraction. Requires EXA_API_KEY for web content and GEMINI_API_KEY for video analysis.",
    promptSnippet:
      "Use to read URLs, repositories, PDFs, YouTube, or local videos. Pass the user's exact question as prompt for video analysis.",
    parameters: FetchParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      const normalized = normalizeFetchParams(params as RawFetchParams);
      if ("error" in normalized) {
        return textResult<FetchDetails>(`Error: ${normalized.error}`, {
          itemCount: 0,
          successful: 0,
          error: normalized.error,
        });
      }
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Fetching ${normalized.urls.length} item${normalized.urls.length === 1 ? "" : "s"}`,
          },
        ],
        details: { itemCount: normalized.urls.length },
      });

      const items = await fetchContent(
        normalized.urls,
        normalized.options,
        signal,
      );
      const responseId = createResponseId();
      const cacheError = await cacheResponse({
        id: responseId,
        type: "fetch",
        timestamp: Date.now(),
        items: items.map(textOnly),
      });
      const successful = items.filter((item) => item.error === null).length;
      const output = [
        ...items.map((item) => formatFetchedItem(item, true)),
        `Response ID: ${responseId}`,
        ...(cacheError ? [`Cache error: ${cacheError}`] : []),
      ].join("\n\n---\n\n");
      const result: AgentToolResult<FetchDetails> = {
        content: [{ type: "text", text: output }],
        details: {
          responseId,
          itemCount: items.length,
          successful,
          ...(successful === 0 ? { error: "All fetches failed" } : {}),
          ...(cacheError ? { cacheError } : {}),
        },
      };
      for (const item of items) {
        if (item.thumbnail)
          result.content.push({ type: "image", ...item.thumbnail });
        for (const frame of item.frames ?? []) {
          result.content.push({
            type: "image",
            data: frame.data,
            mimeType: frame.mimeType,
          });
        }
      }
      return result;
    },
    renderCall(args, theme) {
      const count = args.urls?.length ?? (args.url ? 1 : 0);
      return new Text(
        theme.fg("toolTitle", theme.bold("fetch_content ")) +
          theme.fg("muted", `${count} item${count === 1 ? "" : "s"}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as FetchDetails | undefined;
      if (!details) return new Text("Fetch finished", 0, 0);
      const text = `${details.successful}/${details.itemCount} fetched • ${details.responseId ?? details.error ?? "no response"}`;
      return new Text(
        theme.fg(details.successful > 0 ? "success" : "error", text),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "get_search_content",
    label: "Get Search Content",
    description:
      "Retrieve a cached web_search or fetch_content response. Pass itemIndex to select one query or URL; omit it for the whole response.",
    promptSnippet:
      "Use a response ID to retrieve stored full text, optionally selecting one item by zero-based index.",
    parameters: GetContentParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const response = getResponse(params.responseId);
      if (!response) {
        const error = `Response not found: ${params.responseId}`;
        return textResult<GetContentDetails>(`Error: ${error}`, {
          responseId: params.responseId,
          itemCount: 0,
          error,
        });
      }

      if (
        params.itemIndex !== undefined &&
        (params.itemIndex < 0 || params.itemIndex >= response.items.length)
      ) {
        const error = `itemIndex ${params.itemIndex} is outside 0-${response.items.length - 1}`;
        return textResult<GetContentDetails>(`Error: ${error}`, {
          responseId: params.responseId,
          itemCount: response.items.length,
          itemIndex: params.itemIndex,
          error,
        });
      }

      const output =
        response.type === "search"
          ? (params.itemIndex === undefined
              ? response.items
              : [response.items[params.itemIndex]]
            )
              .map((item) => formatSearchItem(item, true))
              .join("\n\n---\n\n")
          : (params.itemIndex === undefined
              ? response.items
              : [response.items[params.itemIndex]]
            )
              .map((item) => formatFetchedItem(item, false))
              .join("\n\n---\n\n");
      return textResult<GetContentDetails>(output, {
        responseId: response.id,
        itemCount: params.itemIndex === undefined ? response.items.length : 1,
        ...(params.itemIndex !== undefined
          ? { itemIndex: params.itemIndex }
          : {}),
      });
    },
    renderCall(args, theme) {
      const suffix =
        args.itemIndex === undefined ? "all" : `item ${args.itemIndex}`;
      return new Text(
        theme.fg("toolTitle", theme.bold("get_search_content ")) +
          theme.fg("muted", `${args.responseId.slice(0, 8)} • ${suffix}`),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as GetContentDetails | undefined;
      if (!details) return new Text("Content retrieved", 0, 0);
      return new Text(
        theme.fg(
          details.error ? "error" : "success",
          details.error ??
            `${details.itemCount} item${details.itemCount === 1 ? "" : "s"}`,
        ),
        0,
        0,
      );
    },
  });
}
