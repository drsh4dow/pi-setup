import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { promisify } from "node:util";
import { Effect } from "effect";

const { createServer } = process.getBuiltinModule("http");

import type { Context } from "@earendil-works/pi-ai";
import { accountProvider } from "../accounts.ts";

test("an account alias sends Codex tool history and its own account credentials", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const requests: {
				authorization: string | undefined;
				account: string | string[] | undefined;
			}[] = [];
			const server = createServer((request, response) => {
				requests.push({
					authorization: request.headers.authorization,
					account: request.headers["chatgpt-account-id"],
				});
				request.resume();
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const event of [
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "message",
							id: "msg_test",
							role: "assistant",
							content: [{ type: "output_text", text: "Done." }],
						},
					},
					{
						type: "response.completed",
						response: {
							id: "resp_test",
							status: "completed",
							output: [],
							usage: { input_tokens: 8, output_tokens: 2 },
						},
					},
				])
					response.write(`data: ${JSON.stringify(event)}\n\n`);
				response.end();
			});
			server.listen(0, "127.0.0.1");
			yield* Effect.promise(() => once(server, "listening"));
			try {
				const address = server.address();
				assert.ok(address && typeof address === "object");
				const provider = accountProvider({
					label: "A",
					provider: "openai-codex@A",
				});
				const catalogModel = provider
					.getModels()
					.find((model) => model.id === "gpt-5.4");
				assert.ok(catalogModel);
				const model = {
					...catalogModel,
					baseUrl: `http://127.0.0.1:${address.port}`,
				};
				const token = `test.${Buffer.from(
					'{"https://api.openai.com/auth":{"chatgpt_account_id":"test-account-a"}}',
				).toString("base64")}.test`;
				const context: Context = {
					messages: [
						{ role: "user", content: "Read the file.", timestamp: 0 },
						{
							role: "assistant",
							api: "openai-codex-responses",
							provider: "openai-codex@A",
							model: "gpt-5.4",
							timestamp: 1,
							stopReason: "toolUse",
							content: [
								{
									type: "toolCall",
									id: "call_test|fc_test",
									name: "read",
									arguments: { path: "README.md" },
								},
							],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
						},
						{
							role: "toolResult",
							toolCallId: "call_test|fc_test",
							toolName: "read",
							content: [{ type: "text", text: "File contents" }],
							isError: false,
							timestamp: 2,
						},
					],
				};
				let input: unknown;
				const result = yield* Effect.promise(() =>
					provider
						.streamSimple(model, context, {
							apiKey: token,
							transport: "sse",
							maxRetries: 0,
							onPayload(payload) {
								assert.ok(
									payload && typeof payload === "object" && "input" in payload,
								);
								input = payload.input;
							},
						})
						.result(),
				);
				assert.equal(
					result.stopReason,
					"stop",
					result.errorMessage ?? "Unexpected stream failure",
				);
				assert.deepEqual(
					result.content.map((block) =>
						block.type === "text" ? block.text : block.type,
					),
					["Done."],
				);
				assert.deepEqual(requests, [
					{ authorization: `Bearer ${token}`, account: "test-account-a" },
				]);
				assert.deepEqual(input, [
					{
						role: "user",
						content: [{ type: "input_text", text: "Read the file." }],
					},
					{
						type: "function_call",
						id: "fc_test",
						call_id: "call_test",
						name: "read",
						arguments: '{"path":"README.md"}',
					},
					{
						type: "function_call_output",
						call_id: "call_test",
						output: "File contents",
					},
				]);
			} finally {
				const closing = promisify(server.close.bind(server))();
				server.closeAllConnections();
				yield* Effect.promise(() => closing);
			}
		}),
	));
