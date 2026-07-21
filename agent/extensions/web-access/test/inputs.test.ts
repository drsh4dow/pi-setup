import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFetchParams } from "../fetch-content.ts";
import { parseGitHubUrl } from "../github.ts";

test("fetch normalization prefers non-empty plural URLs and deduplicates", () => {
  const result = normalizeFetchParams({
    url: "https://fallback.example",
    urls: [" https://one.example ", "https://one.example"],
    timestamp: "1:00-1:30",
    frames: 6,
  });
  assert.deepEqual(result, {
    urls: ["https://one.example"],
    options: {
      forceClone: undefined,
      prompt: undefined,
      timestamp: "1:00-1:30",
      frames: 6,
      model: undefined,
    },
  });
});

test("fetch normalization enforces URL, prompt, and frame bounds", () => {
  assert.match(
    normalizeFetchParams({
      urls: Array.from(
        { length: 11 },
        (_, index) => `https://example.com/${index}`,
      ),
    }).error ?? "",
    /at most 10/,
  );
  assert.match(
    normalizeFetchParams({ url: "https://example.com", frames: 13 }).error ??
      "",
    /1 to 12/,
  );
  assert.match(
    normalizeFetchParams({
      url: "https://example.com",
      prompt: "x".repeat(10_001),
    }).error ?? "",
    /prompt exceeds/,
  );
  assert.match(
    normalizeFetchParams({ urls: ["https://example.com", 42] }).error ?? "",
    /Every URL/,
  );
});

test("GitHub URL parsing accepts code paths and rejects non-code pages", () => {
  assert.deepEqual(
    parseGitHubUrl("https://github.com/owner/repo/blob/main/src/index.ts"),
    {
      owner: "owner",
      repo: "repo",
      ref: "main",
      refIsFullSha: false,
      path: "src/index.ts",
      type: "blob",
    },
  );
  assert.equal(parseGitHubUrl("https://github.com/owner/repo/issues/1"), null);
});
