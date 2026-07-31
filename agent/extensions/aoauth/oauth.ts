import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import {
	Clock,
	Deferred,
	Effect,
	Layer,
	ManagedRuntime,
	Schema,
	Stream,
} from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT = 54_545;
const CALLBACK_PATH = "/callback";
const CALLBACK_BIND_ERROR =
	"Anthropic OAuth callback server did not bind to TCP";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const EXPIRY_SKEW_MS = 5 * 60_000;
const SERVER_CLOSE_GRACE_MS = 250;
const MAX_CALLBACK_CONNECTIONS = 16;

type AuthorizationCode = { code: string; state: string };
const TokenResponseJson = Schema.Struct({
	access_token: Schema.NonEmptyString,
	refresh_token: Schema.optional(Schema.NonEmptyString),
	expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
});

class OAuthRequestError extends Schema.TaggedErrorClass<OAuthRequestError>()(
	"OAuthRequestError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Defect()),
	},
) {}

const flowError = (message: string, cause?: unknown) =>
	new OAuthRequestError({ message, cause });

type TokenResponse = {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
};

type CallbackServer = {
	redirectUri: string;
	result: Effect.Effect<AuthorizationCode, OAuthRequestError>;
	close: Effect.Effect<void, OAuthRequestError>;
};

function parseAuthorizationInput(input: string): Partial<AuthorizationCode> {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// The input may be a query string or a raw authorization code.
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	const separator = value.indexOf("#");
	if (separator >= 0) {
		return {
			code: value.slice(0, separator),
			state: value.slice(separator + 1) || undefined,
		};
	}

	return { code: value };
}

function handleCallback(
	method: string,
	requestUrl: string,
	expectedState: string,
	settle: (result: AuthorizationCode | OAuthRequestError) => void,
): { status: number; message: string } {
	if (method !== "GET") return { status: 405, message: "Method not allowed" };

	const url = new URL(requestUrl, "http://localhost");
	if (url.pathname !== CALLBACK_PATH) {
		return { status: 404, message: "Callback route not found" };
	}

	const state = url.searchParams.get("state") ?? "";
	const providerError = url.searchParams.get("error");
	if (providerError) {
		const description =
			url.searchParams.get("error_description") ?? providerError;
		if (state === expectedState) {
			settle(flowError(`Anthropic authorization failed: ${description}`));
		}
		return { status: 400, message: `Authorization failed: ${description}` };
	}

	const code = url.searchParams.get("code");
	if (!code) return { status: 400, message: "Missing authorization code" };
	if (state !== expectedState) {
		return { status: 400, message: "OAuth state mismatch" };
	}

	settle({ code, state });
	return {
		status: 200,
		message: "Anthropic authentication completed. You can close this window.",
	};
}

const startBunCallbackServer = Effect.fn("startBunCallbackServer")(function* (
	expectedState: string,
	port: number,
	settle: (result: AuthorizationCode | OAuthRequestError) => void,
): Effect.fn.Return<Omit<CallbackServer, "result">, OAuthRequestError> {
	const app = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const response = handleCallback(
			request.method,
			request.url,
			expectedState,
			settle,
		);
		return HttpServerResponse.text(response.message, {
			status: response.status,
			headers: { Connection: "close" },
		});
	});
	const serverLayer = BunHttpServer.layer({
		hostname: "127.0.0.1",
		port,
		gracefulShutdownTimeout: SERVER_CLOSE_GRACE_MS,
	});
	const runtime = ManagedRuntime.make(
		Layer.merge(
			serverLayer,
			HttpServer.serve(app).pipe(Layer.provide(serverLayer)),
		),
	);
	const dispose = Effect.tryPromise({
		try: () => runtime.dispose(),
		catch: (cause) => flowError("Callback server operation failed", cause),
	});
	const server = yield* Effect.tryPromise({
		try: (signal) => runtime.runPromise(HttpServer.HttpServer, { signal }),
		catch: (cause) => flowError("Callback server operation failed", cause),
	}).pipe(Effect.onError(() => dispose.pipe(Effect.orDie)));
	if (server.address._tag !== "TcpAddress") {
		yield* dispose;
		return yield* flowError(CALLBACK_BIND_ERROR);
	}
	return {
		redirectUri: `http://localhost:${server.address.port}${CALLBACK_PATH}`,
		close: dispose,
	};
});

const startNodeCallbackServer = Effect.fn("startNodeCallbackServer")(function* (
	expectedState: string,
	port: number,
	settle: (result: AuthorizationCode | OAuthRequestError) => void,
): Effect.fn.Return<Omit<CallbackServer, "result">, OAuthRequestError> {
	const nodeHttp = process.getBuiltinModule("node:http");
	const server = nodeHttp.createServer((request, response) => {
		const result = handleCallback(
			request.method ?? "",
			request.url ?? "",
			expectedState,
			settle,
		);
		response.writeHead(result.status, {
			"Content-Type": "text/plain; charset=utf-8",
		});
		response.end(result.message);
	});
	server.maxConnections = MAX_CALLBACK_CONNECTIONS;
	yield* Effect.callback<void, OAuthRequestError>((resume) => {
		const onError = (cause: Error) =>
			resume(Effect.fail(flowError("Failed to start callback server", cause)));
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError);
			resume(Effect.void);
		});
		return Effect.sync(() => server.close());
	});
	server.on("error", (cause) =>
		settle(flowError("Callback server failed", cause)),
	);
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		return yield* flowError(CALLBACK_BIND_ERROR);
	}
	return {
		redirectUri: `http://localhost:${address.port}${CALLBACK_PATH}`,
		close: Effect.callback<void, OAuthRequestError>((resume) => {
			if (!server.listening) {
				resume(Effect.void);
				return;
			}
			server.close((cause) =>
				resume(
					cause
						? Effect.fail(flowError("Failed to close callback server", cause))
						: Effect.void,
				),
			);
			return Effect.sync(() => server.closeAllConnections());
		}).pipe(
			Effect.timeoutOrElse({
				duration: SERVER_CLOSE_GRACE_MS,
				orElse: () => Effect.void,
			}),
		),
	};
});

const startCallbackServer = Effect.fn("startCallbackServer")(function* (
	expectedState: string,
): Effect.fn.Return<CallbackServer, OAuthRequestError> {
	const deferred = yield* Deferred.make<AuthorizationCode, OAuthRequestError>();
	const settle = (outcome: AuthorizationCode | OAuthRequestError) =>
		Deferred.doneUnsafe(
			deferred,
			outcome instanceof Error ? Effect.fail(outcome) : Effect.succeed(outcome),
		);
	const start =
		"Bun" in globalThis ? startBunCallbackServer : startNodeCallbackServer;
	const server = yield* start(expectedState, CALLBACK_PORT, settle).pipe(
		Effect.catch((error) =>
			(error.cause as { code?: string } | undefined)?.code === "EADDRINUSE"
				? start(expectedState, 0, settle)
				: Effect.fail(error),
		),
	);
	return { ...server, result: Deferred.await(deferred) };
});

const abortSignal = Effect.fn("abortSignal")((signal: AbortSignal) =>
	Effect.callback<never, OAuthRequestError>((resume) => {
		const onAbort = () => {
			const message =
				signal.reason instanceof DOMException &&
				signal.reason.name === "TimeoutError"
					? "Anthropic authentication timed out"
					: "Login cancelled";
			resume(Effect.fail(flowError(message)));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => signal.removeEventListener("abort", onAbort));
	}),
);

const waitForAuthorization = Effect.fn("waitForAuthorization")(function* (
	callbackResult: Effect.Effect<AuthorizationCode, OAuthRequestError>,
	callbacks: OAuthLoginCallbacks,
	expectedState: string,
	redirectUri: string,
): Effect.fn.Return<AuthorizationCode, OAuthRequestError> {
	const manualResult = Effect.tryPromise({
		try: () =>
			callbacks.onManualCodeInput
				? callbacks.onManualCodeInput()
				: callbacks.onPrompt({
						message: "Paste the authorization code or full redirect URL:",
						placeholder: redirectUri,
					}),
		catch: (cause) => flowError("Manual authorization failed", cause),
	}).pipe(
		Effect.flatMap((input) => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code)
				return Effect.fail(flowError("Missing authorization code"));
			if (parsed.state && parsed.state !== expectedState)
				return Effect.fail(flowError("OAuth state mismatch"));
			return Effect.succeed({ code: parsed.code, state: expectedState });
		}),
	);
	const authorization = Effect.raceFirst(callbackResult, manualResult).pipe(
		Effect.timeoutOrElse({
			duration: LOGIN_TIMEOUT_MS,
			orElse: () =>
				Effect.fail(flowError("Anthropic authentication timed out")),
		}),
	);
	return yield* callbacks.signal
		? Effect.raceFirst(authorization, abortSignal(callbacks.signal))
		: authorization;
});

const requestToken = Effect.fn("requestToken")(function* (
	operation: string,
	body: Record<string, string>,
	headers?: Record<string, string>,
): Effect.fn.Return<TokenResponse, OAuthRequestError, HttpClient.HttpClient> {
	const client = yield* HttpClient.HttpClient;
	const encodedBody = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
		body,
	).pipe(
		Effect.mapError(
			(cause) =>
				new OAuthRequestError({
					message: `Anthropic ${operation} request encoding failed`,
					cause,
				}),
		),
	);
	const request = HttpClientRequest.post(TOKEN_URL).pipe(
		HttpClientRequest.bodyText(encodedBody),
		HttpClientRequest.setHeaders({
			...headers,
			"Content-Type": "application/json",
		}),
	);
	const response = yield* client.execute(request).pipe(
		Effect.mapError(
			(cause) =>
				new OAuthRequestError({
					message: `Anthropic ${operation} request failed`,
					cause,
				}),
		),
	);
	if (response.status < 200 || response.status >= 300) {
		return yield* new OAuthRequestError({
			message: `Anthropic ${operation} failed with HTTP ${response.status}`,
		});
	}
	const contentLength = Number(response.headers["content-length"]);
	if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
		return yield* new OAuthRequestError({
			message: "Anthropic OAuth response exceeded 64 KiB",
		});
	}
	const bytes = yield* response.stream.pipe(
		Stream.flattenIterable,
		Stream.take(MAX_RESPONSE_BYTES + 1),
		Stream.runCollect,
		Effect.map((bytes) => Uint8Array.from(bytes)),
		Effect.mapError(
			(cause) =>
				new OAuthRequestError({
					message: `Anthropic ${operation} response read failed`,
					cause,
				}),
		),
	);
	if (bytes.byteLength > MAX_RESPONSE_BYTES) {
		return yield* new OAuthRequestError({
			message: "Anthropic OAuth response exceeded 64 KiB",
		});
	}
	const token = yield* Schema.decodeEffect(
		Schema.fromJsonString(TokenResponseJson),
	)(new TextDecoder().decode(bytes)).pipe(
		Effect.mapError(
			() =>
				new OAuthRequestError({
					message: `Anthropic ${operation} returned invalid JSON`,
				}),
		),
	);
	return {
		accessToken: token.access_token,
		refreshToken: token.refresh_token,
		expiresIn: token.expires_in,
	};
});

const runTokenRequest = (
	operation: string,
	body: Record<string, string>,
	headers?: Record<string, string>,
) =>
	requestToken(operation, body, headers).pipe(
		Effect.timeout(REQUEST_TIMEOUT_MS),
		Effect.mapError((cause) =>
			Schema.is(OAuthRequestError)(cause)
				? cause
				: new OAuthRequestError({
						message: `Anthropic ${operation} request failed`,
						cause,
					}),
		),
		Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
		Effect.provide(Layer.fresh(FetchHttpClient.layer)),
	);

const credentialExpiry = Effect.fn("credentialExpiry")(function* (
	expiresInSeconds: number,
) {
	const lifetime = expiresInSeconds * 1000;
	const now = yield* Clock.currentTimeMillis;
	return now + lifetime - Math.min(EXPIRY_SKEW_MS, lifetime / 2);
});

const loginAnthropic = Effect.fn("loginAnthropic")(function* (
	callbacks: OAuthLoginCallbacks,
): Effect.fn.Return<OAuthCredentials, OAuthRequestError> {
	const stateBytes = new Uint8Array(16);
	crypto.getRandomValues(stateBytes);
	const csrfState = Buffer.from(stateBytes).toString("hex");
	const verifierBytes = new Uint8Array(96);
	crypto.getRandomValues(verifierBytes);
	const verifier = Buffer.from(verifierBytes).toString("base64url");
	const digest = yield* Effect.promise(() =>
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
	);
	const challenge = Buffer.from(digest).toString("base64url");
	const server = yield* startCallbackServer(csrfState);
	const authorization = yield* Effect.gen(function* () {
		const params = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: server.redirectUri,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: csrfState,
		});
		callbacks.onAuth({
			url: `${AUTHORIZE_URL}?${params.toString()}`,
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code.",
		});
		callbacks.onProgress?.("Waiting for browser authentication...");
		return yield* waitForAuthorization(
			server.result,
			callbacks,
			csrfState,
			server.redirectUri,
		);
	}).pipe(Effect.ensuring(server.close.pipe(Effect.orDie)));

	callbacks.onProgress?.("Exchanging authorization code for tokens...");
	const tokenRequest = runTokenRequest("token exchange", {
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code: authorization.code,
		state: authorization.state,
		redirect_uri: server.redirectUri,
		code_verifier: verifier,
	});
	const token = yield* callbacks.signal
		? Effect.raceFirst(tokenRequest, abortSignal(callbacks.signal))
		: tokenRequest;
	if (!token.refreshToken) {
		return yield* flowError(
			"Anthropic token exchange response omitted refresh_token",
		);
	}

	return {
		access: token.accessToken,
		refresh: token.refreshToken,
		expires: yield* credentialExpiry(token.expiresIn),
	};
});

export const anthropicOAuth = {
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,
	login: (callbacks) => Effect.runPromise(loginAnthropic(callbacks)),
	refreshToken: (credentials) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const token = yield* runTokenRequest(
					"token refresh",
					{
						grant_type: "refresh_token",
						client_id: CLIENT_ID,
						refresh_token: credentials.refresh,
					},
					{
						"anthropic-beta": "oauth-2025-04-20",
						"User-Agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
					},
				);
				return {
					...credentials,
					access: token.accessToken,
					refresh: token.refreshToken ?? credentials.refresh,
					expires: yield* credentialExpiry(token.expiresIn),
				};
			}),
		),
	getApiKey(credentials) {
		return credentials.access;
	},
} satisfies NonNullable<ProviderConfig["oauth"]>;
