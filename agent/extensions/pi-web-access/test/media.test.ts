import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { queryGeminiVideo } from "../gemini-video.ts";
import { extractMedia, parseTimestamp } from "../media.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GEMINI_API_KEY;

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

  const result = await queryGeminiVideo(
    "Find the error",
    "https://video.test",
    {
      model: "gemini-test",
      mimeType: "video/mp4",
    },
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
  const body = JSON.parse(request.init.body) as {
    contents: Array<{ parts: Array<unknown> }>;
  };
  assert.deepEqual(body.contents[0].parts[0], {
    fileData: { fileUri: "https://video.test", mimeType: "video/mp4" },
  });
});

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0;

test("local frame extraction works with ffmpeg", {
  skip: !ffmpegAvailable,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-access-media-test-"));
  const video = join(root, "sample.mp4");
  try {
    const generated = spawnSync(
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
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);

    const result = await extractMedia(video, { timestamp: "0" });
    assert.equal(result?.error, null);
    assert.equal(result?.thumbnail?.mimeType, "image/jpeg");
    assert.ok((result?.thumbnail?.data.length ?? 0) > 100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
