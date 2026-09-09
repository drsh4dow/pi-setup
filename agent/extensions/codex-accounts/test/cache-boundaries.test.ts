import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Clock, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
	parsePassiveHeaders,
	parseUsageResponse,
	refreshAccountUsage,
	selectAccount,
	updatePassiveUsage,
} from "../usage.ts";

const { createServer } = process.getBuiltinModule("http");
const nativeFetch = Effect.runSync(FetchHttpClient.Fetch);
const { mkdtempSync, rmSync } = process.getBuiltinModule("fs");
const { tmpdir } = process.getBuiltinModule("os");
const { join } = process.getBuiltinModule("path");
const execFile = promisify(process.getBuiltinModule("child_process").execFile);
const account = { label: "A", provider: "openai-codex@A" };
const auth = () =>
	Promise.resolve({ apiKey: "fixture", accountId: "fixture-account" });
const weeklyJson =
	'{"rate_limit":{"primary_window":null,"secondary_window":{"used_percent":15,"limit_window_seconds":604800,"reset_at":2524608000}}}';

test("weekly readings tolerate an absent short window but reject blank usage headers", () => {
	assert.deepEqual(
		parseUsageResponse(
			{
				rate_limit: {
					primary_window: null,
					secondary_window: {
						used_percent: 15,
						limit_window_seconds: 604800,
						reset_at: 2524608000,
					},
				},
			},
			1000,
		),
		{
			kind: "known",
			fetchedAt: 1000,
			weekly: { usedPercent: 15, resetAt: 2524608000 },
		},
	);
	assert.equal(
		parsePassiveHeaders(
			new Headers({
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-used-percent": " ",
				"x-codex-primary-reset-at": "2524608000",
			}),
			1000,
		),
		undefined,
	);
});

test("separate processes coalesce a cold usage read", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const directory = mkdtempSync(join(tmpdir(), "codex-process-cache-"));
			let requests = 0;
			const server = createServer((request, response) => {
				requests++;
				request.resume();
				response.writeHead(200, { "content-type": "application/json" });
				response.end(weeklyJson);
			});
			server.listen(0, "127.0.0.1");
			yield* Effect.promise(() => once(server, "listening"));
			try {
				const address = server.address();
				assert.ok(address && typeof address === "object");
				const args = [
					fileURLToPath(new URL("./usage-worker.ts", import.meta.url)),
					join(directory, "usage.json"),
					`http://127.0.0.1:${address.port}`,
				];
				const results = yield* Effect.promise(() =>
					Promise.all([
						execFile(process.execPath, args),
						execFile(process.execPath, args),
						execFile(process.execPath, args),
					]),
				);
				assert.deepEqual(
					results.map((result) => result.stdout),
					["15", "15", "15"],
				);
				assert.equal(requests, 1);
			} finally {
				const closing = promisify(server.close.bind(server))();
				server.closeAllConnections();
				yield* Effect.promise(() => closing);
				rmSync(directory, { recursive: true, force: true });
			}
		}),
	));

test("an expired reset refreshes within the cache TTL and auth failure becomes ineligible", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const directory = mkdtempSync(join(tmpdir(), "codex-reset-cache-"));
			const cachePath = join(directory, "usage.json");
			const now = yield* Clock.currentTimeMillis;
			try {
				yield* Effect.promise(() =>
					updatePassiveUsage(cachePath, "A", "fixture-account", {
						kind: "known",
						fetchedAt: now,
						weekly: { usedPercent: 99, resetAt: (now - 1) / 1000 },
					}),
				);
				const fresh = yield* Effect.promise(() =>
					refreshAccountUsage({
						account,
						cachePath,
						auth,
						now: () => now,
						fetch: () => Promise.resolve(new Response(weeklyJson)),
					}),
				);
				assert.equal(
					fresh.A?.kind === "known" ? fresh.A.weekly.usedPercent : undefined,
					15,
				);
				let authCalls = 0;
				const failedOptions = {
					account,
					cachePath,
					now: () => now + 1,
					auth: () => {
						authCalls++;
						return Promise.reject(new Error("Login expired"));
					},
				};
				const failed = yield* Effect.promise(() =>
					refreshAccountUsage(failedOptions),
				);
				assert.equal(failed.A?.error, "Login expired");
				assert.equal(selectAccount([account], failed, now + 1), undefined);
				yield* Effect.promise(() => refreshAccountUsage(failedOptions));
				assert.equal(authCalls, 1);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}),
	));

test(
	"usage timeout aborts a response whose body never finishes",
	{ timeout: 40_000 },
	() =>
		Effect.runPromise(
			Effect.gen(function* () {
				const directory = mkdtempSync(join(tmpdir(), "codex-body-timeout-"));
				let closed = false;
				const server = createServer((request, response) => {
					request.resume();
					response.on("close", () => {
						closed = true;
					});
					response.writeHead(200, { "content-type": "application/json" });
					response.write("{");
				});
				server.listen(0, "127.0.0.1");
				yield* Effect.promise(() => once(server, "listening"));
				try {
					const address = server.address();
					assert.ok(address && typeof address === "object");
					let signal: AbortSignal | null | undefined;
					const cache = yield* Effect.promise(() =>
						refreshAccountUsage({
							account,
							cachePath: join(directory, "usage.json"),
							auth,
							fetch: (_input, init) => {
								signal = init?.signal;
								return nativeFetch(`http://127.0.0.1:${address.port}`, init);
							},
						}),
					);
					assert.equal(cache.A?.kind, "error");
					assert.equal(signal?.aborted, true);
					yield* Effect.sleep(20);
					assert.equal(closed, true);
				} finally {
					const closing = promisify(server.close.bind(server))();
					server.closeAllConnections();
					yield* Effect.promise(() => closing);
					rmSync(directory, { recursive: true, force: true });
				}
			}),
		),
);
