import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	createDumpfileWorker,
	presignUpload,
	type WorkerEnv,
} from "../src/worker.ts";

const token = "test-token-without-spaces";
const tokenDigest = createHash("sha256").update(token).digest("hex");

function environment(rateLimit = true): WorkerEnv {
	return {
		CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
		DUMPFILE_TOKEN_SHA256: tokenDigest,
		R2_ACCESS_KEY_ID: "access-key",
		R2_SECRET_ACCESS_KEY: "secret-key",
		UPLOAD_RATE_LIMITER: {
			limit: async () => ({ success: rateLimit }),
		},
	};
}

function uploadRequest(
	body: unknown,
	overrides: { authorization?: string; contentType?: string } = {},
): Request {
	return new Request("https://upload.drsh4dow.dev/v1/uploads", {
		body: JSON.stringify(body),
		headers: {
			Authorization: overrides.authorization ?? `Bearer ${token}`,
			"Content-Type": overrides.contentType ?? "application/json",
		},
		method: "POST",
	});
}

test("authorizes an immutable direct upload and logs only safe fields", async () => {
	const signed: Array<Record<string, unknown>> = [];
	const logs: Array<Readonly<Record<string, unknown>>> = [];
	const now = new Date("2026-08-21T12:00:00.000Z");
	const worker = createDumpfileWorker({
		log: (event) => logs.push(event),
		now: () => now,
		presign: async (input) => {
			signed.push({
				contentType: input.contentType,
				disposition: input.disposition,
				key: input.key,
				size: input.size,
			});
			return "https://account.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=secret";
		},
		randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
	});

	const response = await worker.fetch(
		uploadRequest({ contentType: "image/png", extension: "png", size: 42 }),
		environment(),
	);
	assert.equal(response.status, 201);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	const body = await response.json();
	assert.deepEqual(signed, [
		{
			contentType: "image/png",
			disposition: "inline",
			key: "2026/08/21/000102030405060708090a0b0c0d0e0f.png",
			size: 42,
		},
	]);
	assert.deepEqual(body, {
		key: "2026/08/21/000102030405060708090a0b0c0d0e0f.png",
		publicUrl:
			"https://files.drsh4dow.dev/2026/08/21/000102030405060708090a0b0c0d0e0f.png",
		upload: {
			expiresAt: "2026-08-21T12:05:00.000Z",
			headers: {
				"Cache-Control": "public, max-age=31536000, immutable",
				"Content-Disposition": "inline",
				"Content-Length": "42",
				"Content-Type": "image/png",
			},
			method: "PUT",
			url: "https://account.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=secret",
		},
	});
	const serializedLogs = JSON.stringify(logs);
	assert.equal(serializedLogs.includes(token), false);
	assert.equal(serializedLogs.includes("X-Amz-Signature"), false);
	assert.equal(logs[0]?.status, 201);
});

test("forces executable and unknown content to download", async () => {
	let disposition = "";
	const worker = createDumpfileWorker({
		log: () => {},
		presign: async (input) => {
			disposition = input.disposition;
			return "https://account.r2.cloudflarestorage.com/key?signature=safe";
		},
	});
	const response = await worker.fetch(
		uploadRequest({ contentType: "text/html", extension: "html", size: 3 }),
		environment(),
	);
	assert.equal(response.status, 201);
	assert.equal(disposition, "attachment");
	const body = await response.json();
	assert.equal(body.upload.headers["Content-Disposition"], "attachment");
	assert.equal(body.upload.headers["Content-Type"], "application/octet-stream");
});

test("rejects unauthenticated, malformed, oversized, and rate-limited requests", async () => {
	const worker = createDumpfileWorker({ log: () => {} });
	const cases: Array<[Request, WorkerEnv, number]> = [
		[
			uploadRequest(
				{ contentType: "image/png", extension: "png", size: 1 },
				{ authorization: "Bearer wrong" },
			),
			environment(),
			401,
		],
		[
			uploadRequest({ contentType: "image/png", extension: "../png", size: 1 }),
			environment(),
			400,
		],
		[
			uploadRequest({
				contentType: "image/png",
				extension: "png",
				size: 5 * 1024 * 1024 * 1024 + 1,
			}),
			environment(),
			413,
		],
		[
			uploadRequest({ contentType: "image/png", extension: "png", size: 1 }),
			environment(false),
			429,
		],
	];

	for (const [request, env, status] of cases) {
		const response = await worker.fetch(request, env);
		assert.equal(response.status, status);
		assert.equal(
			response.headers.get("Content-Type"),
			"application/problem+json",
		);
		assert.equal((await response.text()).includes(token), false);
	}
});

test("aws4fetch presigns one PUT with all stored metadata bound", async () => {
	const url = await presignUpload({
		contentType: "video/mp4",
		disposition: "inline",
		env: environment(),
		key: "2026/08/21/abc def.mp4",
		size: 42,
	});
	const parsed = new URL(url);
	assert.equal(
		parsed.hostname,
		"0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
	);
	assert.equal(parsed.pathname, "/dumpfile-prod/2026/08/21/abc%20def.mp4");
	assert.equal(parsed.searchParams.get("X-Amz-Expires"), "300");
	const signedHeaders = parsed.searchParams.get("X-Amz-SignedHeaders") ?? "";
	assert.match(signedHeaders, /cache-control/);
	assert.match(signedHeaders, /content-disposition/);
	assert.match(signedHeaders, /content-length/);
	assert.match(signedHeaders, /content-type/);
});
