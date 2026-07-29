import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import {
	HttpBody,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "effect/unstable/http";
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

const GeminiContentResponse = Schema.Struct({
	candidates: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				content: Schema.optionalKey(
					Schema.Struct({
						parts: Schema.optionalKey(
							Schema.Array(
								Schema.Struct({
									text: Schema.optionalKey(Schema.String),
								}),
							),
						),
					}),
				),
			}),
		),
	),
});

const GeminiUploadResponse = Schema.Struct({
	file: Schema.optionalKey(
		Schema.Struct({
			name: Schema.optionalKey(Schema.String),
			uri: Schema.optionalKey(Schema.String),
		}),
	),
});

const GeminiFileStateResponse = Schema.Struct({
	state: Schema.optionalKey(Schema.String),
});

const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

export interface VideoFile {
	absolutePath: string;
	mimeType: string;
	sizeBytes: number;
}

const apiKey: Effect.Effect<string, WebAccessError> = Effect.suspend(() => {
	const value = process.env.GEMINI_API_KEY?.trim();
	return value
		? Effect.succeed(value)
		: Effect.fail(
				webAccessError("GEMINI_API_KEY is required for video analysis"),
			);
});

function errorBody(
	response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, WebAccessError> {
	return response.text.pipe(
		Effect.map((body) => body.replace(/\s+/g, " ").trim().slice(0, 300)),
		Effect.mapError(asError),
	);
}

function title(text: string, fallback: string): string {
	const heading = text
		.match(/^#{1,2}\s+(.+)/m)?.[1]
		?.replace(/\*+/g, "")
		.trim();
	return heading || fallback;
}

const execute = Effect.fn("execute")(function* (
	request: HttpClientRequest.HttpClientRequest,
	timeoutMs: number,
) {
	const client = yield* HttpClient.HttpClient;
	return yield* client
		.execute(request)
		.pipe(Effect.timeout(timeoutMs), Effect.mapError(asError));
});

export const queryGeminiVideo: (
	prompt: string,
	videoUri: string,
	options?: {
		model?: string;
		mimeType?: string;
		timeoutMs?: number;
	},
) => Effect.Effect<string, WebAccessError> = Effect.fn("queryGeminiVideo")(
	function* (
		prompt: string,
		videoUri: string,
		options: {
			model?: string;
			mimeType?: string;
			timeoutMs?: number;
		} = {},
	) {
		const model = options.model ?? DEFAULT_GEMINI_MODEL;
		const key = yield* apiKey;
		const fileData: Record<string, string> = { fileUri: videoUri };
		if (options.mimeType) fileData.mimeType = options.mimeType;

		const encodedBody = yield* encodeJson({
			contents: [{ role: "user", parts: [{ fileData }, { text: prompt }] }],
		}).pipe(Effect.mapError(asError));
		const request = HttpClientRequest.post(
			`${GEMINI_BASE}/models/${model}:generateContent`,
		).pipe(
			HttpClientRequest.setHeaders({
				"Content-Type": "application/json",
				"x-goog-api-key": key,
			}),
			HttpClientRequest.setBody(
				HttpBody.raw(encodedBody, { contentType: "application/json" }),
			),
		);
		const response = yield* execute(request, options.timeoutMs ?? 120_000);
		if (response.status < 200 || response.status >= 300) {
			return yield* webAccessError(
				`Gemini API error ${response.status}: ${yield* errorBody(response)}`,
			);
		}

		const data = yield* HttpClientResponse.schemaBodyJson(
			GeminiContentResponse,
		)(response).pipe(Effect.mapError(asError));
		const text = data.candidates?.[0]?.content?.parts
			?.flatMap((part) => (part.text ? [part.text] : []))
			.join("\n");
		return text
			? text.slice(0, 100_000)
			: yield* webAccessError("Gemini API returned empty video analysis");
	},
	Effect.provide(BunHttpClient.layer),
);

const upload = Effect.fn("upload")(function* (video: VideoFile) {
	const key = yield* apiKey;
	const path = yield* Path.Path;
	const encodedBody = yield* encodeJson({
		file: { display_name: path.basename(video.absolutePath) },
	}).pipe(Effect.mapError(asError));
	const startRequest = HttpClientRequest.post(
		`${GEMINI_UPLOAD_BASE}/files`,
	).pipe(
		HttpClientRequest.setHeaders({
			"Content-Type": "application/json",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": String(video.sizeBytes),
			"X-Goog-Upload-Header-Content-Type": video.mimeType,
			"X-Goog-Upload-Protocol": "resumable",
			"x-goog-api-key": key,
		}),
		HttpClientRequest.setBody(
			HttpBody.raw(encodedBody, { contentType: "application/json" }),
		),
	);
	const start = yield* execute(startRequest, 180_000);
	if (start.status < 200 || start.status >= 300) {
		return yield* webAccessError(
			`Gemini upload initialization failed ${start.status}: ${yield* errorBody(start)}`,
		);
	}
	const uploadUrl = start.headers["x-goog-upload-url"];
	if (!uploadUrl) {
		return yield* webAccessError("Gemini returned no video upload URL");
	}

	const fs = yield* FileSystem.FileSystem;
	const body = yield* fs
		.readFile(video.absolutePath)
		.pipe(Effect.mapError(asError));
	const uploadRequest = HttpClientRequest.put(uploadUrl).pipe(
		HttpClientRequest.bodyUint8Array(body),
		HttpClientRequest.setHeaders({
			"X-Goog-Upload-Command": "upload, finalize",
			"X-Goog-Upload-Offset": "0",
		}),
	);
	const result = yield* execute(uploadRequest, 180_000);
	if (result.status < 200 || result.status >= 300) {
		return yield* webAccessError(
			`Gemini video upload failed ${result.status}: ${yield* errorBody(result)}`,
		);
	}
	const data = yield* HttpClientResponse.schemaBodyJson(GeminiUploadResponse)(
		result,
	).pipe(Effect.mapError(asError));
	return data.file?.name && data.file.uri
		? { name: data.file.name, uri: data.file.uri }
		: yield* webAccessError("Gemini returned an invalid video upload response");
});

const waitUntilActive = Effect.fn("waitUntilActive")(function* (name: string) {
	const key = yield* apiKey;
	for (let attempt = 0; attempt < 24; attempt += 1) {
		const request = HttpClientRequest.get(`${GEMINI_BASE}/${name}`).pipe(
			HttpClientRequest.setHeader("x-goog-api-key", key),
		);
		const response = yield* execute(request, 15_000);
		if (response.status < 200 || response.status >= 300) {
			return yield* webAccessError(
				`Gemini file-state check failed ${response.status}`,
			);
		}
		const data = yield* HttpClientResponse.schemaBodyJson(
			GeminiFileStateResponse,
		)(response).pipe(Effect.mapError(asError));
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") {
			return yield* webAccessError("Gemini video processing failed");
		}
		yield* Effect.sleep(5_000);
	}
	return yield* webAccessError("Gemini video processing timed out");
}, Effect.mapError(asError));

const remove = Effect.fn("remove")(function* (name: string) {
	return yield* Effect.gen(function* () {
		const key = yield* apiKey;
		const request = HttpClientRequest.delete(`${GEMINI_BASE}/${name}`).pipe(
			HttpClientRequest.setHeader("x-goog-api-key", key),
		);
		const response = yield* execute(request, 15_000);
		if (response.status < 200 || response.status >= 300) {
			yield* Effect.logError(
				`Failed to delete Gemini upload ${name}: HTTP ${response.status}`,
			);
		}
	}).pipe(
		Effect.catch((error) =>
			Effect.logError(
				`Failed to delete Gemini upload ${name}: ${errorMessage(error)}`,
			),
		),
	);
});

export const analyzeYouTube: (
	input: string,
	videoId: string,
	prompt: string,
	model: string,
) => Effect.Effect<ExtractedContent, WebAccessError> = Effect.fn(
	"analyzeYouTube",
)(function* (input: string, videoId: string, prompt: string, model: string) {
	const content = yield* queryGeminiVideo(
		prompt,
		`https://www.youtube.com/watch?v=${videoId}`,
		{ model },
	);
	return {
		url: input,
		title: title(content, "YouTube Video"),
		content,
		error: null,
	};
});

export const analyzeLocalVideo: (
	input: string,
	video: VideoFile,
	prompt: string,
	model: string,
) => Effect.Effect<ExtractedContent, WebAccessError> = Effect.fn(
	"analyzeLocalVideo",
)(
	function* (input: string, video: VideoFile, prompt: string, model: string) {
		const path = yield* Path.Path;
		return yield* Effect.acquireUseRelease(
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
						title: title(content, path.basename(video.absolutePath)),
						content,
						error: null,
					};
				}),
			(uploaded) => remove(uploaded.name),
		);
	},
	Effect.provide(
		Layer.mergeAll(BunHttpClient.layer, BunFileSystem.layer, BunPath.layer),
	),
);
