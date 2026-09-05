import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import test, { type TestContext } from "node:test";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { Clock, Effect } from "effect";
import { anthropicOAuth } from "../oauth.ts";

const nodeHttp = process.getBuiltinModule("node:http");
const createServer = nodeHttp.createServer;
const httpStatus = (url: string, fetch: typeof globalThis.fetch) =>
	fetch(url).then((response) => response.status);
type TestBody = (
	context: TestContext,
) => Generator<Effect.Effect<unknown>, void, never>;
const effectTest = (name: string, body: TestBody) =>
	test(name, (context) => Effect.runPromise(Effect.gen(() => body(context))));
const restoreFetch = (context: TestContext) => {
	const fetch = globalThis.fetch;
	context.after(() => {
		globalThis.fetch = fetch;
	});
	return fetch;
};
const mockTokenResponse = (
	context: TestContext,
	body: unknown,
	onRequest?: (input: RequestInfo | URL, init?: RequestInit) => void,
) => {
	restoreFetch(context);
	globalThis.fetch = (input, init) => {
		onRequest?.(input, init);
		return Promise.resolve(Response.json(body));
	};
};
const listen = Effect.fn("listen")(
	(server: ReturnType<typeof createServer>, port: number) =>
		Effect.callback<void>((resume) => {
			const onError = (error: Error) => resume(Effect.die(error));
			server.once("error", onError);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", onError);
				resume(Effect.void);
			});
			return Effect.sync(() => server.close());
		}),
);
const close = Effect.fn("close")((server: ReturnType<typeof createServer>) =>
	Effect.callback<void>((resume) => {
		server.close((error) => resume(error ? Effect.die(error) : Effect.void));
	}),
);
const closePromise = (server: ReturnType<typeof createServer>) =>
	Effect.runPromise(close(server));
const never = () => Effect.runPromise(Effect.never);
const oauthLogin = Effect.fn("oauthLogin")((input: OAuthLoginCallbacks) =>
	Effect.promise(() => anthropicOAuth.login(input)),
);
const oauthRefresh = Effect.fn("oauthRefresh")((input: OAuthCredentials) =>
	Effect.promise(() => anthropicOAuth.refreshToken(input)),
);
const rejects = Effect.fn("rejects")(
	(promise: Promise<unknown>, expected: Parameters<typeof assert.rejects>[1]) =>
		Effect.promise(() => assert.rejects(promise, expected)),
);
const loginOutcome = (login: Promise<unknown>) =>
	Effect.promise(() =>
		login.then(
			() => "resolved",
			(error: Error) => error.message,
		),
	);

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const OLD_CREDENTIALS = {
	access: "sk-ant-oat-old",
	refresh: "refresh-old",
	expires: 0,
};

function callbackParams(info: { url: string }) {
	const authorizationUrl = new URL(info.url);
	const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
	const state = authorizationUrl.searchParams.get("state");
	assert.ok(redirectUri);
	assert.ok(state);
	return { redirectUri, state };
}

function requestBodyJson<T>(body: RequestInit["body"]): T {
	return JSON.parse(
		typeof body === "string"
			? body
			: new TextDecoder().decode(body as Uint8Array),
	) as T;
}

function callbacks(
	overrides: Partial<OAuthLoginCallbacks>,
): OAuthLoginCallbacks {
	return {
		onAuth() {},
		onDeviceCode() {},
		onPrompt: () => Promise.reject(new Error("unexpected prompt")),
		onSelect: () => Promise.resolve(undefined),
		...overrides,
	};
}

effectTest(
	"logs in with the OMP authorization contract and a manually pasted code",
	function* (t) {
		let authorizationUrl: URL | undefined;
		let tokenRequest: RequestInit | undefined;
		mockTokenResponse(
			t,
			{
				access_token: "sk-ant-oat-access",
				refresh_token: "refresh-token",
				expires_in: 3600,
			},
			(input, init) => {
				assert.equal(String(input), TOKEN_URL);
				tokenRequest = init;
			},
		);

		const before = yield* Clock.currentTimeMillis;
		const credentials = yield* oauthLogin(
			callbacks({
				onAuth(info) {
					authorizationUrl = new URL(info.url);
				},
				onManualCodeInput() {
					assert.ok(authorizationUrl);
					return Promise.resolve(
						`authorization-code#${authorizationUrl.searchParams.get("state")}`,
					);
				},
			}),
		);
		const after = yield* Clock.currentTimeMillis;

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

		const payload = requestBodyJson<Record<string, string>>(tokenRequest?.body);
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
	},
);

effectTest(
	"refreshes with OMP headers while preserving the credential and refresh token",
	function* (t) {
		let tokenRequest: RequestInit | undefined;
		mockTokenResponse(
			t,
			{ access_token: "sk-ant-oat-refreshed", expires_in: 7200 },
			(input, init) => {
				assert.equal(String(input), TOKEN_URL);
				tokenRequest = init;
			},
		);

		const existing = {
			access: "sk-ant-oat-old",
			refresh: "refresh-old",
			expires: 0,
			accountId: "account-1",
			orgId: "org-1",
		} satisfies OAuthCredentials;
		const refreshed = yield* oauthRefresh(existing);

		const headers = new Headers(tokenRequest?.headers);
		assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
		assert.equal(
			headers.get("user-agent"),
			"anthropic-sdk-typescript/0.94.0 userOAuthProvider",
		);
		assert.equal(headers.get("content-type"), "application/json");
		assert.deepEqual(requestBodyJson(tokenRequest?.body), {
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
	},
);

effectTest("persists a rotated refresh token", function* (t) {
	mockTokenResponse(t, {
		access_token: "sk-ant-oat-rotated",
		refresh_token: "refresh-rotated",
		expires_in: 3600,
	});

	const refreshed = yield* oauthRefresh(OLD_CREDENTIALS);

	assert.equal(refreshed.refresh, "refresh-rotated");
});

effectTest("keeps short-lived refreshed credentials usable", function* (t) {
	mockTokenResponse(t, {
		access_token: "sk-ant-oat-short",
		refresh_token: "refresh-short",
		expires_in: 60,
	});

	const before = yield* Clock.currentTimeMillis;
	const refreshed = yield* oauthRefresh(OLD_CREDENTIALS);

	assert.ok(refreshed.expires >= before + 30_000);
	assert.ok(refreshed.expires <= (yield* Clock.currentTimeMillis) + 30_000);
});

effectTest(
	"rejects invalid token responses without exposing their body",
	function* (t) {
		restoreFetch(t);

		globalThis.fetch = () =>
			Promise.resolve(
				new Response('{"error":"sensitive-provider-detail"}', { status: 401 }),
			);
		yield* rejects(
			anthropicOAuth.refreshToken(OLD_CREDENTIALS),
			(error: Error) => {
				assert.match(error.message, /HTTP 401/);
				assert.doesNotMatch(error.message, /sensitive-provider-detail/);
				return true;
			},
		);

		globalThis.fetch = () =>
			Promise.resolve(new Response("not-json", { status: 200 }));
		yield* rejects(
			anthropicOAuth.refreshToken(OLD_CREDENTIALS),
			/returned invalid JSON/,
		);

		globalThis.fetch = () =>
			Promise.resolve(
				Response.json({
					access_token: "secret-access-token",
					refresh_token: "secret-refresh-token",
					expires_in: 0,
				}),
			);
		yield* rejects(
			anthropicOAuth.refreshToken(OLD_CREDENTIALS),
			(error: Error & { cause?: unknown }) => {
				assert.match(error.message, /returned invalid JSON/);
				assert.equal(error.cause, undefined);
				assert.doesNotMatch(JSON.stringify(error), /secret-/);
				return true;
			},
		);
	},
);

effectTest(
	"accepts raw, query-string, and redirect-URL manual input",
	function* (t) {
		const exchangedCodes: string[] = [];
		mockTokenResponse(
			t,
			{
				access_token: "sk-ant-oat-manual",
				refresh_token: "refresh-manual",
				expires_in: 3600,
			},
			(_input, init) => {
				exchangedCodes.push(requestBodyJson<{ code: string }>(init?.body).code);
			},
		);

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
			yield* oauthLogin(
				callbacks({
					onAuth(info) {
						authorizationUrl = new URL(info.url);
					},
					onManualCodeInput() {
						assert.ok(authorizationUrl);
						return Promise.resolve(input(authorizationUrl));
					},
				}),
			);
		}

		assert.deepEqual(exchangedCodes, [
			"raw-code",
			"query-code",
			"redirect-code",
		]);
	},
);

effectTest(
	"accepts the browser callback only after an exact state match",
	function* (t) {
		const nativeFetch = restoreFetch(t);

		globalThis.fetch = (input, init) => {
			if (String(input) !== TOKEN_URL)
				return Reflect.apply(nativeFetch, globalThis, [input, init]);
			return Promise.resolve(
				Response.json({
					access_token: "sk-ant-oat-browser",
					refresh_token: "refresh-browser",
					expires_in: 3600,
				}),
			);
		};

		let callbackRequests: Promise<readonly [number, number]> | undefined;
		const credentials = yield* oauthLogin(
			callbacks({
				onAuth(info) {
					const { redirectUri, state } = callbackParams(info);
					callbackRequests = Promise.all([
						httpStatus(
							`${redirectUri}?code=wrong-code&state=wrong-state`,
							nativeFetch,
						),
						httpStatus(
							`${redirectUri}?code=browser-code&state=${state}`,
							nativeFetch,
						),
					]);
				},
				onManualCodeInput: never,
			}),
		);
		const statuses = yield* Effect.promise(
			() => callbackRequests ?? Promise.resolve([0, 0] as const),
		);

		assert.deepEqual(statuses, [400, 200]);
		assert.equal(credentials.access, "sk-ant-oat-browser");
	},
);

effectTest(
	"surfaces a genuine provider denial without waiting for timeout",
	function* () {
		const nativeFetch = globalThis.fetch;
		let denialRequest: Promise<number> | undefined;

		yield* rejects(
			anthropicOAuth.login(
				callbacks({
					onAuth(info) {
						const { redirectUri, state } = callbackParams(info);
						denialRequest = httpStatus(
							`${redirectUri}?error=access_denied&error_description=Consent+was+denied&state=${state}`,
							nativeFetch,
						);
					},
					onManualCodeInput: never,
				}),
			),
			/Anthropic authorization failed: Consent was denied/,
		);
		assert.equal(
			yield* Effect.promise(() => denialRequest ?? Promise.resolve(0)),
			400,
		);
	},
);

effectTest("cancellation closes the callback server", function* () {
	const controller = new AbortController();
	let callbackPort: number | undefined;

	yield* rejects(
		anthropicOAuth.login(
			callbacks({
				signal: controller.signal,
				onAuth(info) {
					const { redirectUri } = callbackParams(info);
					callbackPort = Number(new URL(redirectUri).port);
					controller.abort();
				},
				onManualCodeInput: never,
			}),
		),
		/Login cancelled/,
	);

	assert.ok(callbackPort);
	const probe = createServer();
	yield* listen(probe, callbackPort);
	yield* close(probe);
});

effectTest(
	"cancellation is observed when manual input aborts synchronously",
	function* () {
		const controller = new AbortController();
		let denialUrl: string | undefined;
		const login = anthropicOAuth.login(
			callbacks({
				signal: controller.signal,
				onAuth(info) {
					const { redirectUri, state } = callbackParams(info);
					denialUrl = `${redirectUri}?error=access_denied&state=${state}`;
				},
				onManualCodeInput() {
					controller.abort();
					return never();
				},
			}),
		);
		let outcome = yield* Effect.raceFirst(
			loginOutcome(login),
			Effect.sleep(100).pipe(Effect.as("still waiting")),
		);
		if (outcome === "still waiting") {
			assert.ok(denialUrl);
			yield* Effect.promise(() =>
				httpStatus(denialUrl as string, globalThis.fetch),
			);
			outcome = yield* loginOutcome(login);
		}

		assert.equal(outcome, "Login cancelled");
	},
);

effectTest(
	"cancellation bounds shutdown with a stalled callback connection",
	function* (t) {
		const controller = new AbortController();
		let socket: ReturnType<typeof connect> | undefined;
		t.after(() => socket?.destroy());

		const login = anthropicOAuth.login(
			callbacks({
				signal: controller.signal,
				onAuth(info) {
					const { redirectUri } = callbackParams(info);
					const url = new URL(redirectUri);
					socket = connect(Number(url.port), "127.0.0.1", () => {
						socket?.write("GET /callback HTTP/1.1\r\nHost: localhost\r\n");
						controller.abort();
					});
				},
				onManualCodeInput: never,
			}),
		);
		// Wall-clock bound: cancellation must settle login without the stalled
		// socket being destroyed first. Slack is 8x SERVER_CLOSE_GRACE_MS.
		const outcome = yield* Effect.raceFirst(
			loginOutcome(login),
			Effect.sleep(2_000).pipe(Effect.as("still waiting")),
		);
		assert.equal(outcome, "Login cancelled");
		socket?.destroy();
	},
);

effectTest("falls back to an available loopback port", function* (t) {
	const blocker = createServer();
	yield* listen(blocker, 54_545);
	t.after(() => closePromise(blocker));

	mockTokenResponse(t, {
		access_token: "sk-ant-oat-fallback",
		refresh_token: "refresh-fallback",
		expires_in: 3600,
	});

	let redirectPort: number | undefined;
	yield* oauthLogin(
		callbacks({
			onAuth(info) {
				const { redirectUri } = callbackParams(info);
				redirectPort = Number(new URL(redirectUri).port);
			},
			onManualCodeInput() {
				assert.ok(redirectPort);
				return Promise.resolve("authorization-code");
			},
		}),
	);

	assert.ok(redirectPort);
	assert.notEqual(redirectPort, 54_545);
});

effectTest(
	"feeds subscription credentials into Pi's built-in Anthropic OAuth transport",
	function* (t) {
		restoreFetch(t);

		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | undefined;
		globalThis.fetch = (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			requestBody = requestBodyJson<Record<string, unknown>>(init?.body);
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
			return Promise.resolve(
				new Response(events, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				}),
			);
		};

		const model = {
			...getModel("anthropic", "claude-sonnet-4-6"),
			baseUrl: "https://anthropic.test",
		};
		const now = yield* Clock.currentTimeMillis;
		const responseStream = streamSimple(
			model,
			{
				systemPrompt: "System instructions",
				messages: [
					{
						role: "user",
						content: "hello",
						timestamp: now,
					},
				],
			},
			{
				apiKey: anthropicOAuth.getApiKey({
					access: "sk-ant-oat-subscription",
					refresh: "refresh-token",
					expires: now + 60_000,
				}),
				maxTokens: 10,
			},
		);
		const iterator = responseStream[Symbol.asyncIterator]();
		let next = yield* Effect.promise(() => iterator.next());
		while (!next.done) {
			if (next.value.type === "error") {
				return yield* Effect.die(new Error(next.value.error.errorMessage));
			}
			next = yield* Effect.promise(() => iterator.next());
		}

		assert.equal(
			requestHeaders?.get("authorization"),
			"Bearer sk-ant-oat-subscription",
		);
		assert.match(
			requestHeaders?.get("anthropic-beta") ?? "",
			/oauth-2025-04-20/,
		);
		assert.equal(requestHeaders?.get("x-app"), "cli");
		assert.ok(requestBody);
		assert.equal(
			(requestBody.system as Array<{ text: string }>)[0]?.text,
			"You are Claude Code, Anthropic's official CLI for Claude.",
		);
	},
);

effectTest(
	"refresh rejects pre-aborted requests without sending credentials",
	function* (t) {
		let requests = 0;
		mockTokenResponse(
			t,
			{ access_token: "synthetic", expires_in: 3600 },
			() => requests++,
		);
		const controller = new AbortController();
		controller.abort();
		const provider: NonNullable<
			import("@earendil-works/pi-coding-agent").ProviderConfig["oauth"]
		> = anthropicOAuth;
		yield* Effect.promise(() =>
			assert.rejects(provider.refreshToken(OLD_CREDENTIALS, controller.signal)),
		);
		assert.equal(requests, 0);
	},
);

effectTest(
	"refresh cancellation aborts an in-flight token request",
	function* (t) {
		restoreFetch(t);
		const started = Promise.withResolvers<AbortSignal>();
		globalThis.fetch = (_input, init) =>
			Effect.runPromise(
				Effect.callback<Response>((resume) => {
					assert.ok(init?.signal);
					const signal = init.signal;
					started.resolve(signal);
					signal.addEventListener("abort", () => resume(Effect.interrupt), {
						once: true,
					});
				}),
			);
		const controller = new AbortController();
		const provider: NonNullable<
			import("@earendil-works/pi-coding-agent").ProviderConfig["oauth"]
		> = anthropicOAuth;
		const refresh = provider.refreshToken(OLD_CREDENTIALS, controller.signal);
		const rejected = assert.rejects(refresh);
		const requestSignal = yield* Effect.promise(() => started.promise);
		controller.abort();
		yield* Effect.promise(() => rejected);
		assert.equal(requestSignal.aborted, true);
	},
);
