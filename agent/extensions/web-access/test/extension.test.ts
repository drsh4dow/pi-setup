import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.EXA_API_KEY;
const originalConsoleError = console.error;
const sessionId = `extension-test-${process.pid}`;
const failedSessionId = `extension-test-failed-${process.pid}`;
const writeFailureSessionId = `extension-test-write-failed-${process.pid}`;

function archivePath(id: string): string {
  const hash = createHash("sha256").update(id).digest("hex");
  return join(tmpdir(), "pi-web-access", hash);
}

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
  console.error = originalConsoleError;
  if (originalKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalKey;
  for (const id of [sessionId, failedSessionId, writeFailureSessionId]) {
    await rm(archivePath(id), { recursive: true, force: true });
  }
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

test("archive write failure preserves fetched content without emitting a response ID", async () => {
  process.env.EXA_API_KEY = "test-exa-key";
  globalThis.fetch = async () =>
    Response.json({
      results: [
        {
          title: "Example",
          url: "https://example.com",
          text: "full extracted text",
        },
      ],
    });

  const { tools, handlers } = loadExtension();
  const sessionStart = handlers.get("session_start") as (
    event: { type: "session_start"; reason: "startup" },
    context: { sessionManager: { getSessionId(): string } },
  ) => Promise<void>;
  await sessionStart(
    { type: "session_start", reason: "startup" },
    { sessionManager: { getSessionId: () => writeFailureSessionId } },
  );
  await rm(archivePath(writeFailureSessionId), {
    recursive: true,
    force: true,
  });
  await writeFile(
    archivePath(writeFailureSessionId),
    "blocks response file creation",
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
  assert.equal(fetched.details.responseId, undefined);
  assert.match(String(fetched.details.archiveError), /ENOTDIR/);
  const text = fetched.content.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /full extracted text/);
  assert.match(text, /Archive error:/);
  assert.doesNotMatch(text, /Response ID:/);
});

test("failed activation clears the prior session and never emits a dead response ID", async () => {
  process.env.EXA_API_KEY = "test-exa-key";
  globalThis.fetch = async () =>
    Response.json({
      results: [
        {
          title: "Example",
          url: "https://example.com",
          text: "full extracted text",
        },
      ],
    });

  const { tools, handlers } = loadExtension();
  const sessionStart = handlers.get("session_start") as (
    event: { type: "session_start"; reason: "startup" },
    context: { sessionManager: { getSessionId(): string } },
  ) => Promise<void>;
  await sessionStart(
    { type: "session_start", reason: "startup" },
    { sessionManager: { getSessionId: () => sessionId } },
  );

  const fetchTool = tools.get("fetch_content");
  const retrievalTool = tools.get("get_search_content");
  assert.ok(fetchTool);
  assert.ok(retrievalTool);
  const first = await fetchTool.execute(
    "call-1",
    { url: "https://example.com" },
    undefined,
    undefined,
    {},
  );
  assert.equal(typeof first.details.responseId, "string");

  await writeFile(archivePath(failedSessionId), "blocks directory creation");
  const errors: string[] = [];
  console.error = (...args) => errors.push(args.join(" "));
  await sessionStart(
    { type: "session_start", reason: "startup" },
    { sessionManager: { getSessionId: () => failedSessionId } },
  );
  assert.match(errors.join("\n"), /Could not open Session Response Archive/);

  const unavailable = await retrievalTool.execute(
    "call-2",
    { responseId: first.details.responseId },
    undefined,
    undefined,
    {},
  );
  assert.match(
    unavailable.content.find((item) => item.type === "text")?.text ?? "",
    /Session Response Archive is unavailable/,
  );

  const unarchived = await fetchTool.execute(
    "call-3",
    { url: "https://example.com" },
    undefined,
    undefined,
    {},
  );
  assert.equal(unarchived.details.successful, 1);
  assert.equal(unarchived.details.responseId, undefined);
  assert.equal(
    unarchived.details.archiveError,
    "Session Response Archive is unavailable",
  );
  const text =
    unarchived.content.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /Archive error: Session Response Archive is unavailable/);
  assert.doesNotMatch(text, /Response ID:/);
});
