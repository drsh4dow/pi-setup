import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { Clock, Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { anthropicOAuth } from "../oauth.ts";

const nodeHttp = process.getBuiltinModule("node:http");
const createServer = nodeHttp.createServer;
const currentTimeMillis = () => Effect.runPromise(Clock.currentTimeMillis);
const httpStatus = (url: string, fetch: typeof globalThis.fetch) =>
	Effect.runPromise(
		HttpClient.get(url).pipe(
			Effect.map((response) => response.status),
			Effect.provideService(FetchHttpClient.Fetch, fetch),
			Effect.provide(FetchHttpClient.layer),
		),
	);

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

function requestBodyText(body: RequestInit["body"]): string {
	return typeof body === "string"
		? body
		: new TextDecoder().decode(body as Uint8Array);
}

function callbacks(
	overrides: Partial<OAuthLoginCallbacks>,
): OAuthLoginCallbacks {
	return {
		onAuth() {},
		onDeviceCode() {},
		async onPrompt() {
			throw new Error("unexpected prompt");
		},
		async onSelect() {
			return undefined;
		},
		...overrides,
	};
}

test("logs in with the OMP authorization contract and a manually pasted code", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let authorizationUrl: URL | undefined;
	let tokenRequest: RequestInit | undefined;
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), TOKEN_URL);
		tokenRequest = init;
		return new Response(
			JSON.stringify({
				access_token: "sk-ant-oat-access",
				refresh_token: "refresh-token",
				expires_in: 3600,
			}),
			{ status: 200 },
		);
	};

	const before = await currentTimeMillis();
	const credentials = await anthropicOAuth.login(
		callbacks({
			onAuth(info) {
				authorizationUrl = new URL(info.url);
			},
			async onManualCodeInput() {
				assert.ok(authorizationUrl);
				return `authorization-code#${authorizationUrl.searchParams.get("state")}`;
			},
		}),
	);
	const after = await currentTimeMillis();

	assert.ok(authorizationUrl);
	assert.equal(
		authorizationUrl.origin + authorizationUrl.pathname,
		"https://claude.ai/oauth/authorize",
	);
	assert.equal(authorizationUrl.searchParams.get("scope"), SCOPES);
	assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
	assert.equal(
		authorizationUrl.searchParams.get("code_challenge_method"),
		"S256",
	);
	assert.match(
		authorizationUrl.searchParams.get("redirect_uri") ?? "",
		/^http:\/\/localhost:\d+\/callback$/,
	);

	const payload = JSON.parse(requestBodyText(tokenRequest?.body)) as Record<
		string,
		string
	>;
	assert.equal(payload.grant_type, "authorization_code");
	assert.equal(payload.code, "authorization-code");
	assert.equal(payload.state, authorizationUrl.searchParams.get("state"));
	assert.equal(
		payload.redirect_uri,
		authorizationUrl.searchParams.get("redirect_uri"),
	);
	assert.equal(
		createHash("sha256").update(payload.code_verifier).digest("base64url"),
		authorizationUrl.searchParams.get("code_challenge"),
	);
	assert.equal(
		new Headers(tokenRequest?.headers).get("content-type"),
		"application/json",
	);
	assert.equal(credentials.access, "sk-ant-oat-access");
	assert.equal(credentials.refresh, "refresh-token");
	assert.ok(credentials.expires >= before + 55 * 60_000);
	assert.ok(credentials.expires <= after + 55 * 60_000);
});

test("refreshes with OMP headers while preserving the credential and refresh token", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let tokenRequest: RequestInit | undefined;
	globalThis.fetch = async (input, init) => {
		assert.equal(String(input), TOKEN_URL);
		tokenRequest = init;
		return new Response(
			JSON.stringify({
				access_token: "sk-ant-oat-refreshed",
				expires_in: 7200,
			}),
			{ status: 200 },
		);
	};

	const existing = {
		access: "sk-ant-oat-old",
		refresh: "refresh-old",
		expires: 0,
		accountId: "account-1",
		orgId: "org-1",
	} satisfies OAuthCredentials;
	const refreshed = await anthropicOAuth.refreshToken(existing);

	const headers = new Headers(tokenRequest?.headers);
	assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
	assert.equal(
		headers.get("user-agent"),
		"anthropic-sdk-typescript/0.94.0 userOAuthProvider",
	);
	assert.equal(headers.get("content-type"), "application/json");
	assert.deepEqual(JSON.parse(requestBodyText(tokenRequest?.body)), {
		grant_type: "refresh_token",
		client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		refresh_token: "refresh-old",
	});
	assert.equal(refreshed.access, "sk-ant-oat-refreshed");
	assert.equal(refreshed.refresh, "refresh-old");
	assert.equal(
		(refreshed as OAuthCredentials & { accountId: string }).accountId,
		"account-1",
	);
	assert.equal(
		(refreshed as OAuthCredentials & { orgId: string }).orgId,
		"org-1",
	);
});

test("persists a rotated refresh token", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				access_token: "sk-ant-oat-rotated",
				refresh_token: "refresh-rotated",
				expires_in: 3600,
			}),
			{ status: 200 },
		);

	const refreshed = await anthropicOAuth.refreshToken({
		access: "sk-ant-oat-old",
		refresh: "refresh-old",
		expires: 0,
	});

	assert.equal(refreshed.refresh, "refresh-rotated");
});

test("keeps short-lived refreshed credentials usable", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				access_token: "sk-ant-oat-short",
				refresh_token: "refresh-short",
				expires_in: 60,
			}),
			{ status: 200 },
		);

	const before = await currentTimeMillis();
	const refreshed = await anthropicOAuth.refreshToken({
		access: "sk-ant-oat-old",
		refresh: "refresh-old",
		expires: 0,
	});

	assert.ok(refreshed.expires >= before + 30_000);
	assert.ok(refreshed.expires <= (await currentTimeMillis()) + 30_000);
});

test("rejects invalid token responses without exposing their body", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	globalThis.fetch = async () =>
		new Response('{"error":"sensitive-provider-detail"}', { status: 401 });
	await assert.rejects(
		anthropicOAuth.refreshToken({
			access: "sk-ant-oat-old",
			refresh: "refresh-old",
			expires: 0,
		}),
		(error: Error) => {
			assert.match(error.message, /HTTP 401/);
			assert.doesNotMatch(error.message, /sensitive-provider-detail/);
			return true;
		},
	);

	globalThis.fetch = async () => new Response("not-json", { status: 200 });
	await assert.rejects(
		anthropicOAuth.refreshToken({
			access: "sk-ant-oat-old",
			refresh: "refresh-old",
			expires: 0,
		}),
		/returned invalid JSON/,
	);

	globalThis.fetch = async () =>
		Response.json({
			access_token: "secret-access-token",
			refresh_token: "secret-refresh-token",
			expires_in: 0,
		});
	await assert.rejects(
		anthropicOAuth.refreshToken({
			access: "sk-ant-oat-old",
			refresh: "refresh-old",
			expires: 0,
		}),
		(error: Error & { cause?: unknown }) => {
			assert.match(error.message, /returned invalid JSON/);
			assert.equal(error.cause, undefined);
			assert.doesNotMatch(JSON.stringify(error), /secret-/);
			return true;
		},
	);
});

test("accepts raw, query-string, and redirect-URL manual input", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	const exchangedCodes: string[] = [];
	globalThis.fetch = async (_input, init) => {
		exchangedCodes.push(
			(JSON.parse(requestBodyText(init?.body)) as { code: string }).code,
		);
		return new Response(
			JSON.stringify({
				access_token: "sk-ant-oat-manual",
				refresh_token: "refresh-manual",
				expires_in: 3600,
			}),
			{ status: 200 },
		);
	};

	const cases = [
		(_url: URL) => "raw-code",
		(url: URL) => `?code=query-code&state=${url.searchParams.get("state")}`,
		(url: URL) => {
			const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", "redirect-code");
			redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
			return redirect.toString();
		},
	];

	for (const input of cases) {
		let authorizationUrl: URL | undefined;
		await anthropicOAuth.login(
			callbacks({
				onAuth(info) {
					authorizationUrl = new URL(info.url);
				},
				async onManualCodeInput() {
					assert.ok(authorizationUrl);
					return input(authorizationUrl);
				},
			}),
		);
	}

	assert.deepEqual(exchangedCodes, ["raw-code", "query-code", "redirect-code"]);
});

test("accepts the browser callback only after an exact state match", async (t) => {
	const nativeFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = nativeFetch;
	});

	globalThis.fetch = async (input, init) => {
		if (String(input) !== TOKEN_URL)
			return Reflect.apply(nativeFetch, globalThis, [input, init]);
		return new Response(
			JSON.stringify({
				access_token: "sk-ant-oat-browser",
				refresh_token: "refresh-browser",
				expires_in: 3600,
			}),
			{ status: 200 },
		);
	};

	let callbackRequests: Promise<void> | undefined;
	let wrongStatus: number | undefined;
	let rightStatus: number | undefined;
	const credentials = await anthropicOAuth.login(
		callbacks({
			onAuth(info) {
				const authorizationUrl = new URL(info.url);
				const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
				const state = authorizationUrl.searchParams.get("state");
				assert.ok(redirectUri);
				assert.ok(state);
				callbackRequests = (async () => {
					wrongStatus = await httpStatus(
						`${redirectUri}?code=wrong-code&state=wrong-state`,
						nativeFetch,
					);
					rightStatus = await httpStatus(
						`${redirectUri}?code=browser-code&state=${state}`,
						nativeFetch,
					);
				})();
			},
			onManualCodeInput: () => new Promise(() => {}),
		}),
	);
	await callbackRequests;

	assert.equal(wrongStatus, 400);
	assert.equal(rightStatus, 200);
	assert.equal(credentials.access, "sk-ant-oat-browser");
});

test("surfaces a genuine provider denial without waiting for timeout", async () => {
	const nativeFetch = globalThis.fetch;
	let denialRequest: Promise<number> | undefined;

	await assert.rejects(
		anthropicOAuth.login(
			callbacks({
				onAuth(info) {
					const authorizationUrl = new URL(info.url);
					const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
					const state = authorizationUrl.searchParams.get("state");
					assert.ok(redirectUri);
					assert.ok(state);
					denialRequest = httpStatus(
						`${redirectUri}?error=access_denied&error_description=Consent+was+denied&state=${state}`,
						nativeFetch,
					);
				},
				onManualCodeInput: () => new Promise(() => {}),
			}),
		),
		/Anthropic authorization failed: Consent was denied/,
	);
	assert.equal(await denialRequest, 400);
});

test("cancellation closes the callback server", async () => {
	const controller = new AbortController();
	let callbackPort: number | undefined;

	await assert.rejects(
		anthropicOAuth.login(
			callbacks({
				signal: controller.signal,
				onAuth(info) {
					const redirectUri = new URL(info.url).searchParams.get(
						"redirect_uri",
					);
					assert.ok(redirectUri);
					callbackPort = Number(new URL(redirectUri).port);
					controller.abort();
				},
				onManualCodeInput: () => new Promise(() => {}),
			}),
		),
		/Login cancelled/,
	);

	assert.ok(callbackPort);
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(callbackPort, "127.0.0.1", resolve);
	});
	await new Promise<void>((resolve, reject) => {
		probe.close((error) => (error ? reject(error) : resolve()));
	});
});

test("cancellation is observed when manual input aborts synchronously", async () => {
	const controller = new AbortController();
	let denialUrl: string | undefined;
	const login = anthropicOAuth.login(
		callbacks({
			signal: controller.signal,
			onAuth(info) {
				const authorizationUrl = new URL(info.url);
				const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
				const state = authorizationUrl.searchParams.get("state");
				assert.ok(redirectUri);
				assert.ok(state);
				denialUrl = `${redirectUri}?error=access_denied&state=${state}`;
			},
			onManualCodeInput() {
				controller.abort();
				return new Promise(() => {});
			},
		}),
	);
	const outcome = await Promise.race([
		login.then(
			() => "resolved",
			(error: Error) => error.message,
		),
		delay(100).then(() => "still waiting"),
	]);
	if (outcome === "still waiting") {
		assert.ok(denialUrl);
		await httpStatus(denialUrl, globalThis.fetch);
		await assert.rejects(login);
	}

	assert.equal(outcome, "Login cancelled");
});

test("cancellation bounds shutdown with a stalled callback connection", async (t) => {
	const controller = new AbortController();
	let socket: ReturnType<typeof connect> | undefined;
	t.after(() => socket?.destroy());

	const login = anthropicOAuth.login(
		callbacks({
			signal: controller.signal,
			onAuth(info) {
				const redirectUri = new URL(info.url).searchParams.get("redirect_uri");
				assert.ok(redirectUri);
				const url = new URL(redirectUri);
				socket = connect(Number(url.port), "127.0.0.1", () => {
					socket?.write("GET /callback HTTP/1.1\r\nHost: localhost\r\n");
					controller.abort();
				});
			},
			onManualCodeInput: () => new Promise(() => {}),
		}),
	);
	const outcome = await Promise.race([
		login.then(
			() => "resolved",
			(error: Error) => error.message,
		),
		delay(750).then(() => "still waiting"),
	]);
	socket?.destroy();
	await assert.rejects(login, /Login cancelled/);

	assert.equal(outcome, "Login cancelled");
});

test("falls back to an available loopback port", async (t) => {
	const blocker = createServer();
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", reject);
		blocker.listen(54_545, "127.0.0.1", resolve);
	});
	t.after(
		() =>
			new Promise<void>((resolve, reject) => {
				blocker.close((error) => (error ? reject(error) : resolve()));
			}),
	);

	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				access_token: "sk-ant-oat-fallback",
				refresh_token: "refresh-fallback",
				expires_in: 3600,
			}),
			{ status: 200 },
		);

	let redirectPort: number | undefined;
	await anthropicOAuth.login(
		callbacks({
			onAuth(info) {
				const redirectUri = new URL(info.url).searchParams.get("redirect_uri");
				assert.ok(redirectUri);
				redirectPort = Number(new URL(redirectUri).port);
			},
			async onManualCodeInput() {
				assert.ok(redirectPort);
				return "authorization-code";
			},
		}),
	);

	assert.ok(redirectPort);
	assert.notEqual(redirectPort, 54_545);
});

test("feeds subscription credentials into Pi's built-in Anthropic OAuth transport", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	let requestHeaders: Headers | undefined;
	let requestBody: Record<string, unknown> | undefined;
	globalThis.fetch = async (_input, init) => {
		requestHeaders = new Headers(init?.headers);
		requestBody = JSON.parse(requestBodyText(init?.body)) as Record<
			string,
			unknown
		>;
		const events = [
			"event: message_start",
			'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}',
			"",
			"event: content_block_start",
			'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
			"",
			"event: content_block_delta",
			'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
			"",
			"event: content_block_stop",
			'data: {"type":"content_block_stop","index":0}',
			"",
			"event: message_delta",
			'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
			"",
			"event: message_stop",
			'data: {"type":"message_stop"}',
			"",
			"",
		].join("\n");
		return new Response(events, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		});
	};

	const model = {
		...getModel("anthropic", "claude-sonnet-4-6"),
		baseUrl: "https://anthropic.test",
	};
	const stream = streamSimple(
		model,
		{
			systemPrompt: "System instructions",
			messages: [
				{
					role: "user",
					content: "hello",
					timestamp: await currentTimeMillis(),
				},
			],
		},
		{
			apiKey: anthropicOAuth.getApiKey({
				access: "sk-ant-oat-subscription",
				refresh: "refresh-token",
				expires: (await currentTimeMillis()) + 60_000,
			}),
			maxTokens: 10,
		},
	);
	for await (const event of stream) {
		if (event.type === "error") throw new Error(event.error.errorMessage);
	}

	assert.equal(
		requestHeaders?.get("authorization"),
		"Bearer sk-ant-oat-subscription",
	);
	assert.match(requestHeaders?.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
	assert.equal(requestHeaders?.get("x-app"), "cli");
	assert.ok(requestBody);
	assert.equal(
		(requestBody.system as Array<{ text: string }>)[0]?.text,
		"You are Claude Code, Anthropic's official CLI for Claude.",
	);
});
