import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { ConfigProvider, Effect, FileSystem, Path, Schema } from "effect";
import { queryGeminiVideo } from "../gemini-video.ts";
import { extractMedia, parseTimestamp } from "../media.ts";
import { runCommand } from "../subprocess.ts";

const fs = Effect.runSync(
	FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer)),
);
const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
const originalFetch = globalThis.fetch;
const testConfig = ConfigProvider.fromUnknown({
	GEMINI_API_KEY: "test-gemini-key",
});

const GeminiRequest = Schema.Struct({
	contents: Schema.Array(
		Schema.Struct({ parts: Schema.Array(Schema.Unknown) }),
	),
});

const run = Effect.runPromise;

afterEach(() => {
	globalThis.fetch = originalFetch;
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

test("Gemini video request uses API-key auth and fileData", () =>
	run(
		Effect.gen(function* () {
			let request: { url: string; init: RequestInit } | undefined;
			globalThis.fetch = (url, init = {}) => {
				request = { url: String(url), init };
				return Promise.resolve(
					Response.json({
						candidates: [
							{ content: { parts: [{ text: "# Analysis\nUseful" }] } },
						],
					}),
				);
			};

			const result = yield* queryGeminiVideo(
				"Find the error",
				"https://video.test",
				{ model: "gemini-test", mimeType: "video/mp4" },
			).pipe(Effect.provideService(ConfigProvider.ConfigProvider, testConfig));

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
			const body = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(GeminiRequest),
			)(request.init.body);
			assert.deepEqual(body.contents[0].parts[0], {
				fileData: { fileUri: "https://video.test", mimeType: "video/mp4" },
			});
		}),
	));

const ffmpegAvailable = await run(
	runCommand("ffmpeg", ["-version"], {
		timeoutMs: 5_000,
		maxBuffer: 1024 * 1024,
	}).pipe(
		Effect.as(true),
		Effect.orElseSucceed(() => false),
	),
);

test("command output overflow remains a typed failure", () =>
	run(
		Effect.gen(function* () {
			const error = yield* runCommand(
				process.execPath,
				["-e", 'process.stdout.write("x".repeat(32))'],
				{ timeoutMs: 5_000, maxBuffer: 16 },
			).pipe(Effect.flip);
			assert.match(String(error), /Command output exceeded 16 bytes/);
		}),
	));

test(
	"local frame extraction works with ffmpeg",
	{ skip: !ffmpegAvailable },
	() =>
		run(
			Effect.gen(function* () {
				const root = yield* fs.makeTempDirectory({
					prefix: "pi-web-access-media-test-",
				});
				const video = path.join(root, "sample.mp4");
				return yield* Effect.gen(function* () {
					yield* runCommand(
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
					);

					const result = yield* extractMedia(video, { timestamp: "0" });
					assert.equal(result?.error, null);
					assert.equal(result?.thumbnail?.mimeType, "image/jpeg");
					const frame = Buffer.from(result?.thumbnail?.data ?? "", "base64");
					assert.deepEqual(
						frame.subarray(0, 3),
						Buffer.from([0xff, 0xd8, 0xff]),
					);
					assert.deepEqual(frame.subarray(-2), Buffer.from([0xff, 0xd9]));
				}).pipe(
					Effect.ensuring(
						fs
							.remove(root, { recursive: true, force: true })
							.pipe(Effect.orDie),
					),
				);
			}),
		),
);
