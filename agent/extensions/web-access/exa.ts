import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import { DateTime, Effect, Schema } from "effect";
import {
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
import { asError, type WebAccessError, webAccessError } from "./errors.ts";
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

const ExaResult = Schema.Struct({
	id: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	title: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
	highlights: Schema.optionalKey(Schema.Unknown),
});
type ExaResult = typeof ExaResult.Type;

const ExaAnswerResponse = Schema.Struct({
	answer: Schema.optionalKey(
		Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Json)]),
	),
	citations: Schema.optionalKey(Schema.Array(ExaResult)),
});

const ExaSearchResponse = Schema.Struct({
	results: Schema.optionalKey(Schema.Array(ExaResult)),
});

const ExaContentsResponse = Schema.Struct({
	results: Schema.optionalKey(Schema.Array(ExaResult)),
	statuses: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				id: Schema.optionalKey(Schema.String),
				status: Schema.optionalKey(Schema.String),
				error: Schema.optionalKey(
					Schema.Union([
						Schema.String,
						Schema.Struct({
							tag: Schema.optionalKey(Schema.String),
							message: Schema.optionalKey(Schema.String),
						}),
					]),
				),
			}),
		),
	),
});
type ExaContentsResponse = typeof ExaContentsResponse.Type;

const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

const apiKey: Effect.Effect<string, WebAccessError> = Effect.suspend(() => {
	const key = process.env.EXA_API_KEY?.trim();
	return key
		? Effect.succeed(key)
		: Effect.fail(
				webAccessError(
					"EXA_API_KEY is required for Exa search and URL extraction",
				),
			);
});

const post = Effect.fn("post")(function* <S extends Schema.Constraint>(
	path: string,
	body: Schema.Json,
	responseSchema: S,
) {
	const client = yield* HttpClient.HttpClient;
	const encodedBody = yield* encodeJson(body).pipe(Effect.mapError(asError));
	const request = HttpClientRequest.post(`${API_BASE}${path}`).pipe(
		HttpClientRequest.setHeaders({
			"Content-Type": "application/json",
			"x-api-key": yield* apiKey,
		}),
		HttpClientRequest.setBody(
			HttpBody.raw(encodedBody, { contentType: "application/json" }),
		),
	);
	const response = yield* client
		.execute(request)
		.pipe(Effect.timeout(REQUEST_TIMEOUT_MS), Effect.mapError(asError));

	if (response.status < 200 || response.status >= 300) {
		const detail = (yield* response.text.pipe(Effect.mapError(asError)))
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 300);
		return yield* webAccessError(
			`Exa API error ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}

	return yield* HttpClientResponse.schemaBodyJson(responseSchema)(
		response,
	).pipe(Effect.mapError(asError));
});

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

function sources(
	results: ReadonlyArray<ExaResult> | undefined,
): SearchSource[] {
	return (results ?? []).flatMap((result, index) => {
		const mapped = source(result, index);
		return mapped ? [mapped] : [];
	});
}

function evidence(results: ReadonlyArray<ExaResult> | undefined): string {
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

function inlineContent(
	results: ReadonlyArray<ExaResult> | undefined,
): ExtractedContent[] {
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

const startPublishedDate = Effect.fn("startPublishedDate")(function* (
	filter: NonNullable<SearchOptions["recencyFilter"]>,
) {
	const days = { day: 1, week: 7, month: 30, year: 365 }[filter];
	return DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days }));
});

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

export const searchExa: (
	query: string,
	options?: SearchOptions,
) => Effect.Effect<SearchResult, WebAccessError> = Effect.fn("searchExa")(
	function* (query: string, options: SearchOptions = {}) {
		const useSearch =
			options.includeContent === true ||
			options.recencyFilter !== undefined ||
			(options.domainFilter !== undefined && options.domainFilter.length > 0) ||
			options.numResults !== undefined;

		if (!useSearch) {
			const response = yield* post(
				"/answer",
				{ query, text: true },
				ExaAnswerResponse,
			);
			const answer =
				typeof response.answer === "string"
					? response.answer
					: response.answer
						? yield* encodeJson(response.answer).pipe(Effect.mapError(asError))
						: "";
			return {
				answer: answer.slice(0, FETCH_CONTENT_CHARS),
				sources: sources(response.citations),
				content: [],
			};
		}

		const response = yield* post(
			"/search",
			{
				query,
				type: "auto",
				numResults: options.numResults ?? 5,
				...domainFilters(options.domainFilter),
				...(options.recencyFilter
					? {
							startPublishedDate: yield* startPublishedDate(
								options.recencyFilter,
							),
						}
					: {}),
				contents: {
					highlights: { maxCharacters: 4_000 },
					...(options.includeContent
						? { text: { maxCharacters: SEARCH_CONTENT_CHARS } }
						: {}),
				},
			},
			ExaSearchResponse,
		);

		return {
			answer: evidence(response.results),
			sources: sources(response.results),
			content: options.includeContent ? inlineContent(response.results) : [],
		};
	},
	Effect.provide(BunHttpClient.layer),
);

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

export const fetchExaContents: (
	urls: string[],
) => Effect.Effect<ExtractedContent[], WebAccessError> = Effect.fn(
	"fetchExaContents",
)(function* (urls: string[]) {
	const response = yield* post(
		"/contents",
		{
			urls,
			text: { maxCharacters: FETCH_CONTENT_CHARS },
			livecrawlTimeout: 15_000,
		},
		ExaContentsResponse,
	);
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
			const message = error ?? "Exa returned no readable content for this URL";
			return { url, title: result?.title ?? "", content: "", error: message };
		}
		return {
			url,
			title: result.title?.trim() || url,
			content: result.text.slice(0, FETCH_CONTENT_CHARS),
			error: null,
		};
	});
}, Effect.provide(BunHttpClient.layer));
