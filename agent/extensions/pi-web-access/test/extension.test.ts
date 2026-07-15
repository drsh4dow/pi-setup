import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.EXA_API_KEY;
const sessionId = `extension-test-${process.pid}`;

interface TestToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details: Record<string, unknown>;
}

interface TestTool {
  parameters: unknown;
  execute(
    callId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ): Promise<TestToolResult>;
}

function loadExtension() {
  const tools = new Map<string, TestTool>();
  const handlers = new Map<string, unknown>();
  const api = {
    on(event: string, handler: unknown) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool as unknown as TestTool);
    },
  } as unknown as ExtensionAPI;
  extension(api);
  return { tools, handlers };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalKey;
  const hash = createHash("sha256").update(sessionId).digest("hex");
  await rm(join(tmpdir(), "pi-web-access", hash), {
    recursive: true,
    force: true,
  });
});

test("extension registers only the three agreed tools", () => {
  const { tools } = loadExtension();
  assert.deepEqual(
    [...tools.keys()],
    ["web_search", "fetch_content", "get_search_content"],
  );
  const search = tools.get("web_search");
  assert.ok(search);
  const searchSchema = JSON.stringify(search.parameters);
  assert.doesNotMatch(searchSchema, /provider|workflow/);
});

test("fetch and retrieval tools work through the registered interface", async () => {
  process.env.EXA_API_KEY = "test-exa-key";
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://api.exa.ai/contents");
    return Response.json({
      results: [
        {
          title: "Example",
          url: "https://example.com",
          text: "full extracted text",
        },
      ],
    });
  };

  const { tools, handlers } = loadExtension();
  const sessionStart = handlers.get("session_start");
  assert.equal(typeof sessionStart, "function");
  await (
    sessionStart as (
      event: { type: "session_start"; reason: "startup" },
      context: { sessionManager: { getSessionId(): string } },
    ) => Promise<void>
  )(
    { type: "session_start", reason: "startup" },
    { sessionManager: { getSessionId: () => sessionId } },
  );

  const fetchTool = tools.get("fetch_content");
  assert.ok(fetchTool);
  const fetched = await fetchTool.execute(
    "call-1",
    { url: "https://example.com" },
    undefined,
    undefined,
    {},
  );
  assert.equal(fetched.details.successful, 1);
  const fetchedText = fetched.content.find(
    (item) => item.type === "text",
  )?.text;
  assert.match(fetchedText ?? "", /full extracted text/);

  const responseId = fetched.details.responseId;
  assert.equal(typeof responseId, "string");
  const retrievalTool = tools.get("get_search_content");
  assert.ok(retrievalTool);
  const retrieved = await retrievalTool.execute(
    "call-2",
    { responseId, itemIndex: 0 },
    undefined,
    undefined,
    {},
  );
  const retrievedText = retrieved.content.find(
    (item) => item.type === "text",
  )?.text;
  assert.match(retrievedText ?? "", /full extracted text/);
});
