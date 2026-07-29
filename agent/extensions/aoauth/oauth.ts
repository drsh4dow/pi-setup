import {
	createServer,
	type IncomingMessage,
	type RequestListener,
	type Server,
	type ServerResponse,
} from "node:http";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthProviderInterface,
} from "@earendil-works/pi-ai/compat";

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

function writeCallbackResponse(
	response: ServerResponse<IncomingMessage>,
	status: number,
	message: string,
) {
	response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	response.end(message);
}

function createCallbackServer(handler: RequestListener): Server {
	const server = createServer(handler);
	server.maxConnections = MAX_CALLBACK_CONNECTIONS;
	return server;
}

function listen(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError);
			resolve();
		});
	});
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

	const handler = (
		request: IncomingMessage,
		response: ServerResponse<IncomingMessage>,
	) => {
		if (request.method !== "GET") {
			writeCallbackResponse(response, 405, "Method not allowed");
			return;
		}

		const url = new URL(request.url ?? "", "http://localhost");
		if (url.pathname !== CALLBACK_PATH) {
			writeCallbackResponse(response, 404, "Callback route not found");
			return;
		}

		const state = url.searchParams.get("state") ?? "";
		const providerError = url.searchParams.get("error");
		if (providerError) {
			const description =
				url.searchParams.get("error_description") ?? providerError;
			writeCallbackResponse(
				response,
				400,
				`Authorization failed: ${description}`,
			);
			if (state === expectedState && !settled) {
				settled = true;
				rejectResult(
					new Error(`Anthropic authorization failed: ${description}`),
				);
			}
			return;
		}

		const code = url.searchParams.get("code");
		if (!code) {
			writeCallbackResponse(response, 400, "Missing authorization code");
			return;
		}
		if (state !== expectedState) {
			writeCallbackResponse(response, 400, "OAuth state mismatch");
			return;
		}

		writeCallbackResponse(
			response,
			200,
			"Anthropic authentication completed. You can close this window.",
		);
		if (!settled) {
			settled = true;
			resolveResult({ code, state });
		}
	};

	let server = createCallbackServer(handler);
	try {
		await listen(server, CALLBACK_PORT);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		server = createCallbackServer(handler);
		await listen(server, 0);
	}

	server.on("error", (error) => {
		if (!settled) {
			settled = true;
			rejectResult(error);
		}
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Anthropic OAuth callback server did not bind to TCP");
	}

	return {
		redirectUri: `http://localhost:${address.port}${CALLBACK_PATH}`,
		result,
		close: () =>
			new Promise((resolve, reject) => {
				if (!server.listening) {
					resolve();
					return;
				}
				const forceClose = setTimeout(() => {
					server.closeAllConnections();
				}, SERVER_CLOSE_GRACE_MS);
				forceClose.unref();
				server.close((error) => {
					clearTimeout(forceClose);
					if (error) reject(error);
					else resolve();
				});
			}),
	};
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

async function readBoundedBody(response: Response): Promise<string> {
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size <= MAX_RESPONSE_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("Anthropic OAuth response exceeded 64 KiB");
		}
		chunks.push(value);
	}

	const body = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function credentialExpiry(expiresInSeconds: number): number {
	const lifetime = expiresInSeconds * 1000;
	return Date.now() + lifetime - Math.min(EXPIRY_SKEW_MS, lifetime / 2);
}

function parseTokenResponse(body: string, operation: string): TokenResponse {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch (error) {
		throw new Error(`Anthropic ${operation} returned invalid JSON`, {
			cause: error,
		});
	}

	if (!value || typeof value !== "object") {
		throw new Error(
			`Anthropic ${operation} returned an invalid token response`,
		);
	}
	const token = value as Record<string, unknown>;
	if (typeof token.access_token !== "string" || token.access_token === "") {
		throw new Error(`Anthropic ${operation} response omitted access_token`);
	}
	if (
		typeof token.expires_in !== "number" ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0
	) {
		throw new Error(`Anthropic ${operation} response had invalid expires_in`);
	}
	if (
		token.refresh_token !== undefined &&
		(typeof token.refresh_token !== "string" || token.refresh_token === "")
	) {
		throw new Error(
			`Anthropic ${operation} response had invalid refresh_token`,
		);
	}

	return {
		accessToken: token.access_token,
		refreshToken: token.refresh_token as string | undefined,
		expiresIn: token.expires_in,
	};
}

async function requestToken(
	operation: string,
	body: Record<string, string>,
	signal?: AbortSignal,
	headers?: Record<string, string>,
): Promise<TokenResponse> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Anthropic ${operation} request failed: ${message}`, {
			cause: error,
		});
	}

	const responseBody = await readBoundedBody(response);
	if (!response.ok) {
		throw new Error(
			`Anthropic ${operation} failed with HTTP ${response.status}`,
		);
	}
	return parseTokenResponse(responseBody, operation);
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
	const token = await requestToken(
		"token exchange",
		{
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: authorization.code,
			state: authorization.state,
			redirect_uri: server.redirectUri,
			code_verifier: verifier,
		},
		callbacks.signal,
	);
	if (!token.refreshToken) {
		throw new Error("Anthropic token exchange response omitted refresh_token");
	}

	return {
		access: token.accessToken,
		refresh: token.refreshToken,
		expires: credentialExpiry(token.expiresIn),
	};
}

export const anthropicOAuth = {
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,
	login: loginAnthropic,
	async refreshToken(credentials) {
		const token = await requestToken(
			"token refresh",
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: credentials.refresh,
			},
			undefined,
			{
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "anthropic-sdk-typescript/0.94.0 userOAuthProvider",
			},
		);
		return {
			...credentials,
			access: token.accessToken,
			refresh: token.refreshToken ?? credentials.refresh,
			expires: credentialExpiry(token.expiresIn),
		};
	},
	getApiKey(credentials) {
		return credentials.access;
	},
} satisfies Omit<OAuthProviderInterface, "id">;
