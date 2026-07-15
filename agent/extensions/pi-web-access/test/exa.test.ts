import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Effect } from "effect";
import { fetchExaContents, searchExa } from "../exa.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.EXA_API_KEY;

beforeEach(() => {
  process.env.EXA_API_KEY = "test-exa-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalKey;
});

test("default search uses Exa answer with citations", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = async (url, init = {}) => {
    request = { url: String(url), init };
    return Response.json({
      answer: "Grounded answer",
      citations: [{ title: "Example", url: "https://example.com" }],
    });
  };

  const result = await Effect.runPromise(searchExa("a focused question"));

  assert.ok(request);
  assert.equal(request.url, "https://api.exa.ai/answer");
  assert.equal(
    new Headers(request.init.headers).get("x-api-key"),
    "test-exa-key",
  );
  if (typeof request.init.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  assert.deepEqual(JSON.parse(request.init.body), {
    query: "a focused question",
    text: true,
  });
  assert.equal(result.answer, "Grounded answer");
  assert.deepEqual(result.sources, [
    { title: "Example", url: "https://example.com", snippet: "" },
  ]);
});

test("an explicit result count uses Exa search even when it is five", async () => {
  let endpoint: string | undefined;
  globalThis.fetch = async (url) => {
    endpoint = String(url);
    return Response.json({ results: [] });
  };

  await Effect.runPromise(searchExa("query", { numResults: 5 }));
  assert.equal(endpoint, "https://api.exa.ai/search");
});

test("filtered search uses Exa search and bounds inline content", async () => {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    body = JSON.parse(init.body) as Record<string, unknown>;
    return Response.json({
      results: [
        {
          title: "Result",
          url: "https://example.com/result",
          highlights: ["Relevant evidence"],
          text: "x".repeat(25_000),
        },
      ],
    });
  };

  const result = await Effect.runPromise(
    searchExa("query", {
      numResults: 7,
      includeContent: true,
      recencyFilter: "week",
      domainFilter: ["example.com", "-ads.example.com"],
    }),
  );

  assert.ok(body);
  assert.equal(body.numResults, 7);
  assert.deepEqual(body.includeDomains, ["example.com"]);
  assert.deepEqual(body.excludeDomains, ["ads.example.com"]);
  if (typeof body.startPublishedDate !== "string") {
    throw new Error("Expected a published-date filter");
  }
  assert.match(body.startPublishedDate, /^\d{4}-\d{2}-\d{2}T/);
  const contents = body.contents as Record<string, unknown>;
  assert.deepEqual(contents.text, { maxCharacters: 20_000 });
  assert.match(result.answer, /Relevant evidence/);
  assert.equal(result.content[0].content.length, 20_000);
});

test("contents preserves per-URL failures", async () => {
  globalThis.fetch = async () =>
    Response.json({
      results: [
        {
          title: "Good",
          url: "https://good.example",
          text: "Readable content",
        },
      ],
      statuses: [
        {
          id: "https://bad.example",
          status: "error",
          error: { tag: "SOURCE_NOT_AVAILABLE" },
        },
      ],
    });

  const result = await Effect.runPromise(
    fetchExaContents(["https://bad.example", "https://good.example"]),
  );

  assert.equal(result[0].error, "SOURCE_NOT_AVAILABLE");
  assert.equal(result[1].content, "Readable content");
  assert.equal(result[1].error, null);
});

test("Effect interruption aborts an in-flight Exa request", async () => {
  let requestSignal: AbortSignal | null | undefined;
  let started: (() => void) | undefined;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  globalThis.fetch = async (_url, init) => {
    requestSignal = init?.signal;
    started?.();
    return new Promise<Response>(() => {});
  };

  const controller = new AbortController();
  const pending = Effect.runPromise(searchExa("query"), {
    signal: controller.signal,
  });
  await requestStarted;
  controller.abort();

  await assert.rejects(pending);
  assert.equal(requestSignal?.aborted, true);
});

test("missing Exa key fails clearly", async () => {
  delete process.env.EXA_API_KEY;
  await assert.rejects(
    () => Effect.runPromise(searchExa("query")),
    /EXA_API_KEY is required/,
  );
});
