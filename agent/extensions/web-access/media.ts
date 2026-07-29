import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Path } from "effect";
import { HttpClient } from "effect/unstable/http";
import {
	asError,
	errorMessage,
	type WebAccessError,
	webAccessError,
} from "./errors.ts";
import {
	analyzeLocalVideo,
	analyzeYouTube,
	DEFAULT_GEMINI_MODEL,
	type VideoFile,
} from "./gemini-video.ts";
import type {
	ExtractedContent,
	FetchOptions,
	FrameData,
	FrameResult,
	VideoFrame,
} from "./types.ts";
import {
	extractLocalFrame,
	extractYouTubeFrame,
	getLocalDuration,
	getYouTubeStream,
} from "./video-frames.ts";

const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_FRAMES = 12;
const FRAME_CONCURRENCY = 2;
const DEFAULT_RANGE_FRAMES = 6;
const MIN_FRAME_INTERVAL_SECONDS = 5;

const DEFAULT_VIDEO_PROMPT = `Extract the complete content of this video. Include:
1. Video title and duration
2. A brief summary
3. A full transcript with timestamps
4. Descriptions of code, commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const VIDEO_TYPES: Record<string, string> = {
	".3gp": "video/3gpp",
	".3gpp": "video/3gpp",
	".avi": "video/x-msvideo",
	".flv": "video/x-flv",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".mpeg": "video/mpeg",
	".mpg": "video/mpeg",
	".webm": "video/webm",
	".wmv": "video/x-ms-wmv",
};

const YOUTUBE_PATTERN =
	/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

interface MediaTarget {
	kind: "youtube" | "local";
	input: string;
	videoId?: string;
	local?: VideoFile;
}

function youtubeVideoId(input: string): string | null {
	try {
		const parsed = new URL(input);
		if (parsed.pathname === "/playlist") return null;
	} catch {
		return null;
	}
	return input.match(YOUTUBE_PATTERN)?.[1] ?? null;
}

function normalizeSpaces(value: string): string {
	return value.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

function localVideoPath(
	input: string,
): { filePath: string; mimeType: string } | { error: string } | null {
	if (
		!input.startsWith("/") &&
		!input.startsWith("./") &&
		!input.startsWith("../") &&
		!input.startsWith("file://")
	) {
		return null;
	}
	let filePath = input;
	if (input.startsWith("file://")) {
		try {
			filePath = decodeURIComponent(new URL(input).pathname);
		} catch {
			return { error: "Invalid file URL" };
		}
	}
	const mimeType = VIDEO_TYPES[path.extname(filePath).toLowerCase()];
	return mimeType ? { filePath, mimeType } : null;
}

const target = Effect.fn("target")(function* (input: string) {
	const videoId = youtubeVideoId(input);
	if (videoId) return { kind: "youtube", input, videoId } satisfies MediaTarget;
	const local = localVideoPath(input);
	if (!local || "error" in local) return local;

	const fs = yield* FileSystem.FileSystem;
	const absolutePath = path.resolve(local.filePath);
	const exists = yield* fs.exists(absolutePath);
	let resolvedPath = absolutePath;
	if (!exists) {
		const parent = path.dirname(absolutePath);
		if (!(yield* fs.exists(parent))) {
			return { error: `Video file not found: ${local.filePath}` };
		}
		const normalized = normalizeSpaces(path.basename(absolutePath));
		const entries = yield* fs
			.readDirectory(parent)
			.pipe(Effect.orElseSucceed(() => []));
		const match = entries.find(
			(entry) => normalizeSpaces(entry) === normalized,
		);
		if (!match) return { error: `Video file not found: ${local.filePath}` };
		resolvedPath = path.join(parent, match);
	}

	const stats = yield* fs
		.stat(resolvedPath)
		.pipe(
			Effect.mapError((error) =>
				webAccessError(
					`Could not inspect video: ${errorMessage(error)}`,
					error,
				),
			),
		);
	if (stats.type !== "File") return { error: `Not a file: ${local.filePath}` };
	if (stats.size > BigInt(MAX_VIDEO_BYTES)) {
		return { error: "Local video exceeds the 50 MB limit" };
	}
	return {
		kind: "local",
		input,
		local: {
			absolutePath: resolvedPath,
			mimeType: local.mimeType,
			sizeBytes: Number(stats.size),
		},
	} satisfies MediaTarget;
}, Effect.provide(BunFileSystem.layer));

function parseSeconds(value: string): number | null {
	const numeric = Number(value);
	if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric);
	const parts = value.split(":").map(Number);
	if (
		(parts.length !== 2 && parts.length !== 3) ||
		parts.some((part) => !Number.isFinite(part) || part < 0)
	) {
		return null;
	}
	return Math.floor(
		parts.length === 3
			? parts[0] * 3_600 + parts[1] * 60 + parts[2]
			: parts[0] * 60 + parts[1],
	);
}

export type TimestampSpec =
	| { type: "single"; seconds: number }
	| { type: "range"; start: number; end: number };

export function parseTimestamp(value: string): TimestampSpec | null {
	const separator = value.indexOf("-", 1);
	if (separator > 0) {
		const start = parseSeconds(value.slice(0, separator));
		const end = parseSeconds(value.slice(separator + 1));
		if (start !== null && end !== null && end > start) {
			return { type: "range", start, end };
		}
		return null;
	}
	const seconds = parseSeconds(value);
	return seconds === null ? null : { type: "single", seconds };
}

function formatSeconds(seconds: number): string {
	const hours = Math.floor(seconds / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const remainder = seconds % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
		: `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function timestamps(
	start: number,
	end: number,
	requested = DEFAULT_RANGE_FRAMES,
) {
	const count = Math.min(requested, MAX_FRAMES);
	if (count <= 1) return [start];
	const interval = (end - start) / (count - 1);
	if (interval < MIN_FRAME_INTERVAL_SECONDS) {
		const values: number[] = [];
		for (
			let current = start;
			current <= end && values.length < count;
			current += MIN_FRAME_INTERVAL_SECONDS
		) {
			values.push(current);
		}
		return values;
	}
	return Array.from({ length: count }, (_, index) =>
		Math.round(start + interval * index),
	);
}

function extractFrames(
	media: MediaTarget,
	values: number[],
): Effect.Effect<
	{ frames: VideoFrame[]; error: string | null; duration?: number },
	WebAccessError
> {
	return Effect.gen(function* () {
		const stream =
			media.kind === "youtube"
				? yield* getYouTubeStream(media.videoId as string)
				: undefined;
		const results = yield* Effect.forEach(
			values,
			(seconds): Effect.Effect<VideoFrame | { error: string }> => {
				const frame = stream
					? extractYouTubeFrame(stream.streamUrl, seconds)
					: extractLocalFrame(media.local?.absolutePath as string, seconds);
				return frame.pipe(
					Effect.map((result) =>
						"error" in result
							? result
							: { ...result, timestamp: formatSeconds(seconds) },
					),
				);
			},
			{ concurrency: FRAME_CONCURRENCY },
		);
		const frames = results.filter(
			(frame): frame is VideoFrame => "data" in frame,
		);
		const firstError = results.find(
			(frame): frame is { error: string } => "error" in frame,
		);
		return {
			frames,
			error:
				frames.length === 0
					? (firstError?.error ?? "Frame extraction failed")
					: null,
			duration: stream?.duration ?? undefined,
		};
	});
}

function frameResult(
	input: string,
	label: string,
	requested: number,
	result: {
		frames: VideoFrame[];
		error: string | null;
		duration?: number;
	},
): ExtractedContent {
	if (result.frames.length === 0) {
		const error = result.error ?? "Frame extraction failed";
		return {
			url: input,
			title: `Frames ${label} (0/${requested})`,
			content: "",
			error,
		};
	}
	return {
		url: input,
		title: `Frames ${label} (${result.frames.length}/${requested})`,
		content: `${result.frames.length} frames extracted from ${label}`,
		error: null,
		frames: result.frames,
		duration: result.duration,
	};
}

function mediaDuration(
	media: MediaTarget,
): Effect.Effect<number, WebAccessError> {
	if (media.kind === "local") {
		return getLocalDuration(media.local?.absolutePath as string);
	}
	return getYouTubeStream(media.videoId as string).pipe(
		Effect.flatMap((stream) =>
			stream.duration === null
				? Effect.fail(
						webAccessError(
							"Cannot determine video duration; provide an explicit timestamp range",
						),
					)
				: Effect.succeed(stream.duration),
		),
	);
}

function extractRequestedFrames(
	media: MediaTarget,
	options: FetchOptions,
): Effect.Effect<ExtractedContent, WebAccessError> {
	return Effect.gen(function* () {
		if (options.frames && !options.timestamp) {
			const duration = yield* mediaDuration(media);
			const values = timestamps(0, Math.floor(duration), options.frames);
			const label = `0:00-${formatSeconds(Math.floor(duration))}`;
			return frameResult(
				media.input,
				label,
				values.length,
				yield* extractFrames(media, values),
			);
		}

		const spec = parseTimestamp(options.timestamp as string);
		if (!spec) {
			return yield* webAccessError(`Invalid timestamp: ${options.timestamp}`);
		}

		if (spec.type === "range") {
			const values = timestamps(spec.start, spec.end, options.frames);
			const label = `${formatSeconds(spec.start)}-${formatSeconds(spec.end)}`;
			return frameResult(
				media.input,
				label,
				values.length,
				yield* extractFrames(media, values),
			);
		}

		if (options.frames) {
			const end =
				spec.seconds + (options.frames - 1) * MIN_FRAME_INTERVAL_SECONDS;
			const values = timestamps(spec.seconds, end, options.frames);
			const label = `${formatSeconds(spec.seconds)}-${formatSeconds(end)}`;
			return frameResult(
				media.input,
				label,
				values.length,
				yield* extractFrames(media, values),
			);
		}

		const frame: FrameResult =
			media.kind === "youtube"
				? yield* getYouTubeStream(media.videoId as string).pipe(
						Effect.flatMap((stream) =>
							extractYouTubeFrame(stream.streamUrl, spec.seconds),
						),
					)
				: yield* extractLocalFrame(
						media.local?.absolutePath as string,
						spec.seconds,
					);
		if ("error" in frame) {
			return yield* webAccessError(frame.error);
		}
		return {
			url: media.input,
			title: `Frame at ${formatSeconds(spec.seconds)}`,
			content: `Video frame at ${formatSeconds(spec.seconds)}`,
			error: null,
			thumbnail: frame,
		};
	});
}

function youtubeThumbnail(
	videoId: string,
): Effect.Effect<FrameData | undefined> {
	return Effect.gen(function* () {
		const response = yield* HttpClient.get(
			`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
		).pipe(
			Effect.timeout(5_000),
			Effect.provide(BunHttpClient.layer),
			Effect.mapError(asError),
		);
		if (response.status < 200 || response.status >= 300) return undefined;
		const data = Buffer.from(yield* response.arrayBuffer);
		return data.length > 0
			? { data: data.toString("base64"), mimeType: "image/jpeg" }
			: undefined;
	}).pipe(Effect.orElseSucceed(() => undefined));
}

function analyze(
	media: MediaTarget,
	options: FetchOptions,
): Effect.Effect<ExtractedContent, WebAccessError> {
	const prompt = options.prompt ?? DEFAULT_VIDEO_PROMPT;
	const model = options.model ?? DEFAULT_GEMINI_MODEL;
	if (media.kind === "youtube") {
		return Effect.gen(function* () {
			const result = yield* analyzeYouTube(
				media.input,
				media.videoId as string,
				prompt,
				model,
			);
			const thumbnail = yield* youtubeThumbnail(media.videoId as string);
			return thumbnail ? { ...result, thumbnail } : result;
		});
	}

	const local = media.local as VideoFile;
	return Effect.gen(function* () {
		const result = yield* analyzeLocalVideo(media.input, local, prompt, model);
		const thumbnail = yield* extractLocalFrame(local.absolutePath, 1);
		return "error" in thumbnail ? result : { ...result, thumbnail };
	});
}

export function isMediaInput(input: string): boolean {
	return youtubeVideoId(input) !== null || localVideoPath(input) !== null;
}

export const extractMedia = Effect.fn("extractMedia")(function* (
	input: string,
	options: FetchOptions,
) {
	const media = yield* target(input).pipe(
		Effect.catch((error) => Effect.succeed({ error: errorMessage(error) })),
	);
	if (!media) return null;
	if ("error" in media) {
		return { url: input, title: "", content: "", error: media.error };
	}

	return yield* (
		options.timestamp || options.frames
			? extractRequestedFrames(media, options)
			: analyze(media, options)
	).pipe(
		Effect.catch((error) =>
			Effect.succeed({
				url: input,
				title: "",
				content: "",
				error: errorMessage(error),
			}),
		),
	);
});
