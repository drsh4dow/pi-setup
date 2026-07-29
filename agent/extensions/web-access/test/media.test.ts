import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Path, Schema } from "effect";
import { queryGeminiVideo } from "../gemini-video.ts";
import { extractMedia, parseTimestamp } from "../media.ts";
import { runCommand } from "../subprocess.ts";

const fs = Effect.runSync(
	FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer)),
);
const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
const originalFetch = globalThis.fetch;
const originalKey = process.env.GEMINI_API_KEY;

const GeminiRequest = Schema.Struct({
	contents: Schema.Array(
		Schema.Struct({ parts: Schema.Array(Schema.Unknown) }),
	),
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
	else process.env.GEMINI_API_KEY = originalKey;
});

test("timestamp parsing accepts singles and ranges and rejects reversed ranges", () => {
	assert.deepEqual(parseTimestamp("1:23"), { type: "single", seconds: 83 });
	assert.deepEqual(parseTimestamp("1:00-1:30"), {
		type: "range",
		start: 60,
		end: 90,
	});
	assert.equal(parseTimestamp("1:30-1:00"), null);
});

test("Gemini video request uses API-key auth and fileData", async () => {
	process.env.GEMINI_API_KEY = "test-gemini-key";
	let request: { url: string; init: RequestInit } | undefined;
	globalThis.fetch = async (url, init = {}) => {
		request = { url: String(url), init };
		return Response.json({
			candidates: [{ content: { parts: [{ text: "# Analysis\nUseful" }] } }],
		});
	};

	const result = await Effect.runPromise(
		queryGeminiVideo("Find the error", "https://video.test", {
			model: "gemini-test",
			mimeType: "video/mp4",
		}),
	);

	assert.equal(result, "# Analysis\nUseful");
	assert.ok(request);
	assert.equal(
		new Headers(request.init.headers).get("x-goog-api-key"),
		"test-gemini-key",
	);
	assert.match(request.url, /models\/gemini-test:generateContent$/);
	if (typeof request.init.body !== "string") {
		throw new Error("Expected a JSON request body");
	}
	const body = Schema.decodeUnknownSync(Schema.fromJsonString(GeminiRequest))(
		request.init.body,
	);
	assert.deepEqual(body.contents[0].parts[0], {
		fileData: { fileUri: "https://video.test", mimeType: "video/mp4" },
	});
});

const ffmpegAvailable = await Effect.runPromise(
	runCommand("ffmpeg", ["-version"], {
		timeoutMs: 5_000,
		maxBuffer: 1024 * 1024,
	}).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	),
);

test("local frame extraction works with ffmpeg", {
	skip: !ffmpegAvailable,
}, async () => {
	const root = await Effect.runPromise(
		fs.makeTempDirectory({ prefix: "pi-web-access-media-test-" }),
	);
	const video = path.join(root, "sample.mp4");
	try {
		await Effect.runPromise(
			runCommand(
				"ffmpeg",
				[
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"color=c=blue:s=160x90:d=1",
					"-pix_fmt",
					"yuv420p",
					video,
				],
				{ timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
			),
		);

		const result = await Effect.runPromise(
			extractMedia(video, { timestamp: "0" }),
		);
		assert.equal(result?.error, null);
		assert.equal(result?.thumbnail?.mimeType, "image/jpeg");
		const frame = Buffer.from(result?.thumbnail?.data ?? "", "base64");
		assert.deepEqual(frame.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
		assert.deepEqual(frame.subarray(-2), Buffer.from([0xff, 0xd9]));
	} finally {
		await Effect.runPromise(fs.remove(root, { recursive: true, force: true }));
	}
});
