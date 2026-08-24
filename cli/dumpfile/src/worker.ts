import { AwsClient } from "aws4fetch";
import {
	BUCKET_NAME,
	CACHE_CONTROL,
	dispositionForContentType,
	MAX_UPLOAD_BYTES,
	PUBLIC_BASE_URL,
	SIGNATURE_TTL_SECONDS,
	type StoredDisposition,
	type UploadAuthorization,
	type UploadAuthorizationRequest,
} from "./contract.ts";

interface RateLimiter {
	limit(input: {
		readonly key: string;
	}): Promise<{ readonly success: boolean }>;
}

export interface WorkerEnv {
	readonly CLOUDFLARE_ACCOUNT_ID: string;
	readonly DUMPFILE_TOKEN_SHA256: string;
	readonly R2_ACCESS_KEY_ID: string;
	readonly R2_SECRET_ACCESS_KEY: string;
	readonly UPLOAD_RATE_LIMITER: RateLimiter;
}

interface PresignInput {
	readonly contentType: string;
	readonly disposition: StoredDisposition;
	readonly env: WorkerEnv;
	readonly key: string;
	readonly size: number;
}

interface WorkerDependencies {
	readonly log: (event: Readonly<Record<string, unknown>>) => void;
	readonly now: () => Date;
	readonly presign: (input: PresignInput) => Promise<string>;
	readonly randomBytes: (length: number) => Uint8Array;
}

const problemBase = "https://upload.drsh4dow.dev/problems";
const contentTypePattern =
	/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const extensionPattern = /^[a-z0-9]{1,16}$/;

function problem(
	status: number,
	title: string,
	detail: string,
	type: string,
): Response {
	return Response.json(
		{
			detail,
			status,
			title,
			type: `${problemBase}/${type}`,
		},
		{
			headers: {
				"Cache-Control": "no-store",
				"Content-Type": "application/problem+json",
			},
			status,
		},
	);
}

function parseUploadRequest(
	raw: unknown,
): UploadAuthorizationRequest | Response {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return problem(
			400,
			"Invalid request",
			"Expected a JSON object.",
			"invalid-request",
		);
	}

	const keys = Object.keys(raw);
	if (
		keys.length !== 3 ||
		!keys.includes("contentType") ||
		!keys.includes("extension") ||
		!keys.includes("size") ||
		!("contentType" in raw) ||
		!("extension" in raw) ||
		!("size" in raw)
	) {
		return problem(
			400,
			"Invalid request",
			"Expected only contentType, extension, and size.",
			"invalid-request",
		);
	}

	if (
		typeof raw.size !== "number" ||
		!Number.isSafeInteger(raw.size) ||
		raw.size < 0
	) {
		return problem(
			400,
			"Invalid size",
			"size must be a non-negative integer.",
			"invalid-size",
		);
	}
	if (raw.size > MAX_UPLOAD_BYTES) {
		return problem(
			413,
			"File too large",
			"The direct upload transport supports files up to 5 GiB.",
			"file-too-large",
		);
	}
	if (
		typeof raw.contentType !== "string" ||
		!contentTypePattern.test(raw.contentType)
	) {
		return problem(
			400,
			"Invalid content type",
			"contentType must be a valid media type without parameters.",
			"invalid-content-type",
		);
	}
	if (
		typeof raw.extension !== "string" ||
		(raw.extension !== "" && !extensionPattern.test(raw.extension))
	) {
		return problem(
			400,
			"Invalid extension",
			"extension must be empty or 1-16 lowercase letters or digits.",
			"invalid-extension",
		);
	}

	return {
		contentType: raw.contentType,
		extension: raw.extension,
		size: raw.size,
	};
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

async function authenticated(
	request: Request,
	env: WorkerEnv,
): Promise<boolean> {
	if (!/^[a-f0-9]{64}$/.test(env.DUMPFILE_TOKEN_SHA256)) return false;
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) return false;
	const token = authorization.slice("Bearer ".length);
	if (token.length === 0 || /\s/.test(token)) return false;
	return constantTimeEqual(await sha256(token), env.DUMPFILE_TOKEN_SHA256);
}

function randomBytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

function randomHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function objectKey(now: Date, extension: string, bytes: Uint8Array): string {
	const date = now.toISOString().slice(0, 10).replaceAll("-", "/");
	const suffix = extension === "" ? "" : `.${extension}`;
	return `${date}/${randomHex(bytes)}${suffix}`;
}

export async function presignUpload(input: PresignInput): Promise<string> {
	const headers = new Headers({
		"Cache-Control": CACHE_CONTROL,
		"Content-Disposition": input.disposition,
		"Content-Length": String(input.size),
		"Content-Type": input.contentType,
	});
	const endpoint = new URL(
		`https://${input.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	);
	endpoint.pathname = `/${BUCKET_NAME}/${input.key
		.split("/")
		.map(encodeURIComponent)
		.join("/")}`;
	endpoint.searchParams.set("X-Amz-Expires", String(SIGNATURE_TTL_SECONDS));

	const client = new AwsClient({
		accessKeyId: input.env.R2_ACCESS_KEY_ID,
		region: "auto",
		secretAccessKey: input.env.R2_SECRET_ACCESS_KEY,
		service: "s3",
	});
	const signed = await client.sign(
		new Request(endpoint, { headers, method: "PUT" }),
		{ aws: { allHeaders: true, signQuery: true } },
	);
	return signed.url;
}

const defaultDependencies: WorkerDependencies = {
	log: (event) => console.log(JSON.stringify(event)),
	now: () => new Date(),
	presign: presignUpload,
	randomBytes,
};

export function createDumpfileWorker(
	overrides: Partial<WorkerDependencies> = {},
): { fetch(request: Request, env: WorkerEnv): Promise<Response> } {
	const dependencies = { ...defaultDependencies, ...overrides };

	return {
		async fetch(request, env) {
			const startedAt = dependencies.now();
			const requestId = request.headers.get("cf-ray") ?? "local";
			const log = (
				status: number,
				fields: Readonly<Record<string, unknown>> = {},
			) =>
				dependencies.log({
					requestId,
					status,
					timestamp: startedAt.toISOString(),
					tokenId: "pi-local",
					...fields,
				});

			if (new URL(request.url).pathname !== "/v1/uploads") {
				log(404);
				return problem(
					404,
					"Not found",
					"No route exists at this path.",
					"not-found",
				);
			}
			if (request.method !== "POST") {
				log(405);
				const response = problem(
					405,
					"Method not allowed",
					"Use POST for upload authorization.",
					"method-not-allowed",
				);
				response.headers.set("Allow", "POST");
				return response;
			}
			if (!(await authenticated(request, env))) {
				log(401, { tokenId: "unknown" });
				return problem(
					401,
					"Unauthorized",
					"A valid upload token is required.",
					"unauthorized",
				);
			}

			const rateLimit = await env.UPLOAD_RATE_LIMITER.limit({
				key: "pi-local",
			});
			if (!rateLimit.success) {
				log(429);
				return problem(
					429,
					"Too many requests",
					"The emergency upload authorization ceiling was reached.",
					"rate-limited",
				);
			}
			if (
				request.headers.get("Content-Type")?.split(";", 1)[0] !==
				"application/json"
			) {
				log(415);
				return problem(
					415,
					"Unsupported request",
					"Use Content-Type: application/json.",
					"unsupported-request",
				);
			}

			let raw: unknown;
			try {
				raw = await request.json();
			} catch {
				log(400);
				return problem(
					400,
					"Invalid JSON",
					"The request body is not valid JSON.",
					"invalid-json",
				);
			}
			const parsed = parseUploadRequest(raw);
			if (parsed instanceof Response) {
				log(parsed.status);
				return parsed;
			}

			try {
				const now = startedAt;
				const key = objectKey(
					now,
					parsed.extension,
					dependencies.randomBytes(16),
				);
				const disposition = dispositionForContentType(parsed.contentType);
				const storedContentType =
					disposition === "inline"
						? parsed.contentType
						: "application/octet-stream";
				const uploadUrl = await dependencies.presign({
					contentType: storedContentType,
					disposition,
					env,
					key,
					size: parsed.size,
				});
				const headers = {
					"Cache-Control": CACHE_CONTROL,
					"Content-Disposition": disposition,
					"Content-Length": String(parsed.size),
					"Content-Type": storedContentType,
				};
				const authorization: UploadAuthorization = {
					key,
					publicUrl: `${PUBLIC_BASE_URL}/${key}`,
					upload: {
						expiresAt: new Date(
							now.getTime() + SIGNATURE_TTL_SECONDS * 1000,
						).toISOString(),
						headers,
						method: "PUT",
						url: uploadUrl,
					},
				};
				log(201, {
					contentType: storedContentType,
					key,
					latencyMs: dependencies.now().getTime() - startedAt.getTime(),
					size: parsed.size,
				});
				return Response.json(authorization, {
					headers: { "Cache-Control": "no-store" },
					status: 201,
				});
			} catch {
				log(500);
				return problem(
					500,
					"Signing failed",
					"The upload could not be authorized.",
					"signing-failed",
				);
			}
		},
	};
}

export default createDumpfileWorker();
