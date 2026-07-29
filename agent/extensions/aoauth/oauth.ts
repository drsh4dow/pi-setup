import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import {
	Clock,
	Effect,
	Fiber,
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

type TokenResponse = {
	accessToken: string;
	refreshToken?: string;
	expiresIn: number;
};

type CallbackServer = {
	redirectUri: string;
	result: Promise<AuthorizationCode>;
	close(): Promise<void>;
};

async function generatePkce() {
	const verifierBytes = new Uint8Array(96);
	crypto.getRandomValues(verifierBytes);
	const verifier = Buffer.from(verifierBytes).toString("base64url");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("hex");
}

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
	settle: (result: AuthorizationCode | Error) => void,
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
			settle(new Error(`Anthropic authorization failed: ${description}`));
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

async function startBunCallbackServer(
	expectedState: string,
	port: number,
	settle: (result: AuthorizationCode | Error) => void,
): Promise<Omit<CallbackServer, "result">> {
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
	try {
		const server = await runtime.runPromise(HttpServer.HttpServer);
		if (server.address._tag !== "TcpAddress") {
			throw new Error("Anthropic OAuth callback server did not bind to TCP");
		}
		return {
			redirectUri: `http://localhost:${server.address.port}${CALLBACK_PATH}`,
			close: () => runtime.dispose(),
		};
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
}

async function startNodeCallbackServer(
	expectedState: string,
	port: number,
	settle: (result: AuthorizationCode | Error) => void,
): Promise<Omit<CallbackServer, "result">> {
	// Node-based extension tests cannot instantiate BunHttpServer because Bun.serve
	// is not present. Keep this host boundary local; production Bun uses Effect above.
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
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
	server.on("error", settle);
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Anthropic OAuth callback server did not bind to TCP");
	}
	return {
		redirectUri: `http://localhost:${address.port}${CALLBACK_PATH}`,
		close: () =>
			new Promise((resolve, reject) => {
				if (!server.listening) return resolve();
				const forceClose = Effect.runFork(
					Effect.sleep(SERVER_CLOSE_GRACE_MS).pipe(
						Effect.andThen(Effect.sync(() => server.closeAllConnections())),
					),
				);
				server.close((error) => {
					Effect.runFork(Fiber.interrupt(forceClose));
					if (error) reject(error);
					else resolve();
				});
			}),
	};
}

async function startCallbackServer(
	expectedState: string,
): Promise<CallbackServer> {
	let resolveResult!: (result: AuthorizationCode) => void;
	let rejectResult!: (error: Error) => void;
	let settled = false;
	const result = new Promise<AuthorizationCode>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const settle = (outcome: AuthorizationCode | Error) => {
		if (settled) return;
		settled = true;
		if (outcome instanceof Error) rejectResult(outcome);
		else resolveResult(outcome);
	};
	const start =
		"Bun" in globalThis ? startBunCallbackServer : startNodeCallbackServer;

	let server: Omit<CallbackServer, "result">;
	try {
		server = await start(expectedState, CALLBACK_PORT, settle);
	} catch (error) {
		if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
		server = await start(expectedState, 0, settle);
	}
	return { ...server, result };
}

function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof DOMException &&
		signal.reason.name === "TimeoutError"
		? new Error("Anthropic authentication timed out")
		: new Error("Login cancelled");
}

async function waitForAuthorization(
	callbackResult: Promise<AuthorizationCode>,
	callbacks: OAuthLoginCallbacks,
	expectedState: string,
	redirectUri: string,
): Promise<AuthorizationCode> {
	const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const signal = callbacks.signal
		? AbortSignal.any([callbacks.signal, timeout])
		: timeout;
	let onAbort!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(cancellationError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});

	try {
		if (signal.aborted) throw cancellationError(signal);
		const manualInput = callbacks.onManualCodeInput
			? callbacks.onManualCodeInput()
			: callbacks.onPrompt({
					message: "Paste the authorization code or full redirect URL:",
					placeholder: redirectUri,
				});
		const manualResult = manualInput.then((input): AuthorizationCode => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) throw new Error("Missing authorization code");
			if (parsed.state && parsed.state !== expectedState) {
				throw new Error("OAuth state mismatch");
			}
			return { code: parsed.code, state: expectedState };
		});

		return await Promise.race([callbackResult, manualResult, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

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
		Effect.timeout(REQUEST_TIMEOUT_MS),
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
			(cause) =>
				new OAuthRequestError({
					message: `Anthropic ${operation} returned invalid JSON`,
					cause,
				}),
		),
	);
	return {
		accessToken: token.access_token,
		refreshToken: token.refresh_token,
		expiresIn: token.expires_in,
	};
});

const runTokenRequest = <A>(
	effect: Effect.Effect<A, OAuthRequestError, HttpClient.HttpClient>,
	options?: { signal?: AbortSignal },
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
			Effect.provide(Layer.fresh(FetchHttpClient.layer)),
		),
		options,
	);

async function credentialExpiry(expiresInSeconds: number): Promise<number> {
	const lifetime = expiresInSeconds * 1000;
	const now = await Effect.runPromise(Clock.currentTimeMillis);
	return now + lifetime - Math.min(EXPIRY_SKEW_MS, lifetime / 2);
}

async function loginAnthropic(
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const csrfState = generateState();
	const { verifier, challenge } = await generatePkce();
	const server = await startCallbackServer(csrfState);

	let authorization: AuthorizationCode;
	try {
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
		authorization = await waitForAuthorization(
			server.result,
			callbacks,
			csrfState,
			server.redirectUri,
		);
	} finally {
		await server.close();
	}

	callbacks.onProgress?.("Exchanging authorization code for tokens...");
	const token = await runTokenRequest(
		requestToken(
			"token exchange",
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: authorization.code,
				state: authorization.state,
				redirect_uri: server.redirectUri,
				code_verifier: verifier,
			},
			undefined,
		),
		{ signal: callbacks.signal },
	);
	if (!token.refreshToken) {
		throw new Error("Anthropic token exchange response omitted refresh_token");
	}

	return {
		access: token.accessToken,
		refresh: token.refreshToken,
		expires: await credentialExpiry(token.expiresIn),
	};
}

export const anthropicOAuth = {
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,
	login: loginAnthropic,
	async refreshToken(credentials) {
		const token = await runTokenRequest(
			requestToken(
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
			),
		);
		return {
			...credentials,
			access: token.accessToken,
			refresh: token.refreshToken ?? credentials.refresh,
			expires: await credentialExpiry(token.expiresIn),
		};
	},
	getApiKey(credentials) {
		return credentials.access;
	},
} satisfies NonNullable<ProviderConfig["oauth"]>;
