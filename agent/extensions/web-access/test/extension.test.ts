import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { ConfigProvider, Effect, FileSystem, Path } from "effect";
import { clearStaleCloneCaches } from "../clone-cache.ts";
import extension from "../index.ts";

const fs = Effect.runSync(
	FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer)),
);
const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));
const originalFetch = globalThis.fetch;
const testConfig = ConfigProvider.fromUnknown({ EXA_API_KEY: "test-exa-key" });
const sessionId = `extension-test-${process.pid}`;
const failedSessionId = `extension-test-failed-${process.pid}`;
const writeFailureSessionId = `extension-test-write-failed-${process.pid}`;
const staleCloneTestRoot = `/tmp/pi-web-access-stale-test-${process.pid}`;

function archivePath(id: string): string {
	const hash = createHash("sha256").update(id).digest("hex");
	return path.join("/tmp", "pi-web-access", hash);
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
	extension(api, testConfig);
	return { tools, handlers };
}

const run = Effect.runPromise;

const invokeTool = (
	tool: TestTool,
	callId: string,
	params: Record<string, unknown>,
) =>
	Effect.tryPromise(() =>
		tool.execute(callId, params, undefined, undefined, {}),
	);

const startSession = (handlers: Map<string, unknown>, id: string) =>
	Effect.tryPromise(() => {
		const start = handlers.get("session_start") as (
			event: { type: "session_start"; reason: "startup" },
			context: { sessionManager: { getSessionId(): string } },
		) => Promise<void>;
		return start(
			{ type: "session_start", reason: "startup" },
			{ sessionManager: { getSessionId: () => id } },
		);
	});

function useExaFetch(assertEndpoint = false) {
	globalThis.fetch = (url) => {
		if (assertEndpoint) {
			assert.equal(String(url), "https://api.exa.ai/contents");
		}
		return Promise.resolve(
			Response.json({
				results: [
					{
						title: "Example",
						url: "https://example.com",
						text: "full extracted text",
					},
				],
			}),
		);
	};
}

afterEach(() =>
	run(
		Effect.gen(function* () {
			globalThis.fetch = originalFetch;
			for (const id of [sessionId, failedSessionId, writeFailureSessionId]) {
				yield* fs.remove(archivePath(id), { recursive: true, force: true });
			}
			yield* fs.remove(staleCloneTestRoot, { recursive: true, force: true });
		}),
	),
);

test("stale clone caches from crashed Pi processes are removed", () =>
	run(
		Effect.gen(function* () {
			const cacheRoot = path.join(staleCloneTestRoot, "pi-web-access-repos");
			const active = path.join(cacheRoot, String(process.pid));
			const stale = path.join(cacheRoot, "99999999");
			yield* fs.makeDirectory(active, { recursive: true });
			yield* fs.makeDirectory(stale, { recursive: true });

			const removed = yield* clearStaleCloneCaches().pipe(
				Effect.provideService(
					ConfigProvider.ConfigProvider,
					ConfigProvider.fromUnknown({ TMPDIR: staleCloneTestRoot }),
				),
			);

			assert.equal(removed, 1);
			assert.equal(yield* fs.exists(active), true);
			assert.equal(yield* fs.exists(stale), false);
		}),
	));

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

test("fetch and retrieval tools work through the registered interface", () =>
	run(
		Effect.gen(function* () {
			useExaFetch(true);
			const { tools, handlers } = loadExtension();
			yield* startSession(handlers, sessionId);

			const fetchTool = tools.get("fetch_content");
			assert.ok(fetchTool);
			const fetched = yield* invokeTool(fetchTool, "call-1", {
				url: "https://example.com",
			});
			assert.equal(fetched.details.successful, 1);
			const fetchedText = fetched.content.find(
				(item) => item.type === "text",
			)?.text;
			assert.match(fetchedText ?? "", /full extracted text/);
			const responseId = fetched.details.responseId;
			assert.equal(typeof responseId, "string");
			const retrievalTool = tools.get("get_search_content");
			assert.ok(retrievalTool);
			const retrieved = yield* invokeTool(retrievalTool, "call-2", {
				responseId,
				itemIndex: 0,
			});
			const retrievedText = retrieved.content.find(
				(item) => item.type === "text",
			)?.text;
			assert.match(retrievedText ?? "", /full extracted text/);
		}),
	));

test("archive write failure preserves fetched content without emitting a response ID", () =>
	run(
		Effect.gen(function* () {
			useExaFetch();
			const { tools, handlers } = loadExtension();
			yield* startSession(handlers, writeFailureSessionId);
			yield* fs.remove(archivePath(writeFailureSessionId), {
				recursive: true,
				force: true,
			});
			yield* fs.writeFileString(
				archivePath(writeFailureSessionId),
				"blocks response file creation",
			);
			const fetchTool = tools.get("fetch_content");
			assert.ok(fetchTool);
			const fetched = yield* invokeTool(fetchTool, "call-1", {
				url: "https://example.com",
			});
			assert.equal(fetched.details.successful, 1);
			assert.equal(fetched.details.responseId, undefined);
			assert.match(String(fetched.details.archiveError), /ENOTDIR/);
			const text =
				fetched.content.find((item) => item.type === "text")?.text ?? "";
			assert.match(text, /full extracted text/);
			assert.match(text, /Archive error:/);
			assert.doesNotMatch(text, /Response ID:/);
		}),
	));

test("failed activation clears the prior session and never emits a dead response ID", () =>
	run(
		Effect.gen(function* () {
			useExaFetch();
			const { tools, handlers } = loadExtension();
			yield* startSession(handlers, sessionId);

			const fetchTool = tools.get("fetch_content");
			const retrievalTool = tools.get("get_search_content");
			assert.ok(fetchTool);
			assert.ok(retrievalTool);
			const first = yield* invokeTool(fetchTool, "call-1", {
				url: "https://example.com",
			});
			assert.equal(typeof first.details.responseId, "string");

			yield* fs.writeFileString(
				archivePath(failedSessionId),
				"blocks directory creation",
			);
			yield* startSession(handlers, failedSessionId);

			const unavailable = yield* invokeTool(retrievalTool, "call-2", {
				responseId: first.details.responseId,
			});
			assert.match(
				unavailable.content.find((item) => item.type === "text")?.text ?? "",
				/Session Response Archive is unavailable/,
			);

			const unarchived = yield* invokeTool(fetchTool, "call-3", {
				url: "https://example.com",
			});
			assert.equal(unarchived.details.successful, 1);
			assert.equal(unarchived.details.responseId, undefined);
			assert.equal(
				unarchived.details.archiveError,
				"Session Response Archive is unavailable",
			);
			const text =
				unarchived.content.find((item) => item.type === "text")?.text ?? "";
			assert.match(
				text,
				/Archive error: Session Response Archive is unavailable/,
			);
			assert.doesNotMatch(text, /Response ID:/);
		}),
	));
