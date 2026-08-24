#!/usr/bin/env bun

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BUCKET_NAME,
	CACHE_CONTROL,
	contentTypeForExtension,
	MAX_UPLOAD_BYTES,
	PUBLIC_BASE_URL,
	type UploadAuthorization,
	type UploadAuthorizationRequest,
} from "./contract.ts";

interface BunRuntime {
	file(path: string): Blob;
}

declare const Bun: BunRuntime;

interface Output {
	write(text: string): void;
}

interface CliDependencies {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly fetch: typeof fetch;
	readonly fileBody: (path: string) => BodyInit;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly stderr: Output;
	readonly stdout: Output;
}

interface Config {
	readonly accountId: string;
	readonly apiUrl: string;
	readonly token: string;
}

interface UploadResult {
	readonly bytes: number;
	readonly contentType: string;
	readonly key: string;
	readonly url: string;
	readonly verified: true;
}

class CliError extends Error {}

const usage = `Usage: dumpfile upload <path> [--json]

Publishes supporting evidence for PRs and human review.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvFile(source: string, path: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator < 1) {
			throw new CliError(`${path}:${index + 1}: expected KEY=VALUE`);
		}
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
			throw new CliError(`${path}:${index + 1}: invalid configuration key`);
		}
		if (key in values) {
			throw new CliError(
				`${path}:${index + 1}: duplicate configuration key ${key}`,
			);
		}
		values[key] = value;
	}
	return values;
}

async function readConfig(env: CliDependencies["env"]): Promise<Config> {
	const path =
		env.DUMPFILE_CONFIG_FILE ?? `${homedir()}/.config/dumpfile/config.env`;
	let fromFile: Record<string, string> = {};
	try {
		const file = await import("node:fs/promises").then((fs) => fs.stat(path));
		if (!file.isFile()) throw new CliError(`${path} is not a regular file`);
		if (process.platform !== "win32" && (file.mode & 0o077) !== 0) {
			throw new CliError(`${path} must have mode 0600`);
		}
		fromFile = parseEnvFile(await readFile(path, "utf8"), path);
	} catch (error) {
		if (error instanceof CliError) throw error;
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
	}

	const accountId =
		env.DUMPFILE_R2_ACCOUNT_ID ?? fromFile.DUMPFILE_R2_ACCOUNT_ID;
	const token = env.DUMPFILE_TOKEN ?? fromFile.DUMPFILE_TOKEN;
	const apiUrl = env.DUMPFILE_API_URL ?? fromFile.DUMPFILE_API_URL;
	if (!accountId || !/^[a-f0-9]{32}$/.test(accountId)) {
		throw new CliError(
			`Set a valid DUMPFILE_R2_ACCOUNT_ID in the environment or ${path}`,
		);
	}
	if (!token || /\s/u.test(token)) {
		throw new CliError(`Set DUMPFILE_TOKEN in the environment or ${path}`);
	}
	if (!apiUrl) {
		throw new CliError(`Set DUMPFILE_API_URL in the environment or ${path}`);
	}
	let parsedApiUrl: URL;
	try {
		parsedApiUrl = new URL(apiUrl);
	} catch {
		throw new CliError("DUMPFILE_API_URL must be a valid URL");
	}
	if (
		parsedApiUrl.protocol !== "https:" ||
		parsedApiUrl.username ||
		parsedApiUrl.password
	) {
		throw new CliError(
			"DUMPFILE_API_URL must be an HTTPS URL without credentials",
		);
	}
	return {
		accountId,
		apiUrl: parsedApiUrl.href.replace(/\/$/u, ""),
		token,
	};
}

function parseAuthorization(raw: unknown, config: Config): UploadAuthorization {
	if (
		!isRecord(raw) ||
		typeof raw.key !== "string" ||
		raw.key.length === 0 ||
		raw.key.includes("..") ||
		typeof raw.publicUrl !== "string" ||
		!isRecord(raw.upload) ||
		raw.upload.method !== "PUT" ||
		typeof raw.upload.url !== "string" ||
		typeof raw.upload.expiresAt !== "string" ||
		!isRecord(raw.upload.headers)
	) {
		throw new CliError("The signing service returned an invalid response");
	}

	if (
		!/^\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(raw.key)
	) {
		throw new CliError("The signing service returned an invalid object key");
	}
	const publicUrl = secureUrl(raw.publicUrl, "publicUrl");
	if (publicUrl.href !== `${PUBLIC_BASE_URL}/${raw.key}`) {
		throw new CliError("The signing service returned an unexpected publicUrl");
	}
	const uploadUrl = secureUrl(raw.upload.url, "upload.url");
	if (
		uploadUrl.hostname !== `${config.accountId}.r2.cloudflarestorage.com` ||
		uploadUrl.pathname !== `/${BUCKET_NAME}/${raw.key}` ||
		uploadUrl.searchParams.get("X-Amz-Signature") === null ||
		uploadUrl.hash !== ""
	) {
		throw new CliError(
			"The signing service returned an unexpected R2 upload URL",
		);
	}
	if (Number.isNaN(Date.parse(raw.upload.expiresAt))) {
		throw new CliError("The signing service returned an invalid expiry");
	}
	const headerKeys = Object.keys(raw.upload.headers);
	const cacheControl = raw.upload.headers["Cache-Control"];
	const disposition = raw.upload.headers["Content-Disposition"];
	const contentLength = raw.upload.headers["Content-Length"];
	const contentType = raw.upload.headers["Content-Type"];
	if (
		headerKeys.length !== 4 ||
		typeof cacheControl !== "string" ||
		(disposition !== "attachment" && disposition !== "inline") ||
		typeof contentLength !== "string" ||
		!/^\d+$/.test(contentLength) ||
		typeof contentType !== "string"
	) {
		throw new CliError("The signing service returned invalid upload headers");
	}

	return {
		key: raw.key,
		publicUrl: publicUrl.href,
		upload: {
			expiresAt: raw.upload.expiresAt,
			headers: {
				"Cache-Control": cacheControl,
				"Content-Disposition": disposition,
				"Content-Length": contentLength,
				"Content-Type": contentType,
			},
			method: "PUT",
			url: uploadUrl.href,
		},
	};
}

function secureUrl(raw: string, field: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new CliError(`The signing service returned an invalid ${field}`);
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new CliError(`The signing service returned an insecure ${field}`);
	}
	return url;
}

async function authorize(
	config: Config,
	request: UploadAuthorizationRequest,
	fetcher: typeof fetch,
): Promise<UploadAuthorization> {
	const response = await fetcher(`${config.apiUrl}/v1/uploads`, {
		body: JSON.stringify(request),
		headers: {
			Authorization: `Bearer ${config.token}`,
			"Content-Type": "application/json",
		},
		method: "POST",
	});
	if (response.status !== 201) {
		throw new CliError(`Upload authorization failed: HTTP ${response.status}`);
	}
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		throw new CliError("The signing service returned invalid JSON");
	}
	return parseAuthorization(raw, config);
}

async function uploadWithOneRetry(
	config: Config,
	request: UploadAuthorizationRequest,
	path: string,
	dependencies: CliDependencies,
): Promise<UploadAuthorization> {
	let lastStatus = 0;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const authorization = await authorize(config, request, dependencies.fetch);
		if (
			Number(authorization.upload.headers["Content-Length"]) !== request.size
		) {
			throw new CliError(
				"The signing service returned the wrong Content-Length",
			);
		}
		let response: Response;
		try {
			response = await dependencies.fetch(authorization.upload.url, {
				body: dependencies.fileBody(path),
				headers: {
					"Cache-Control": authorization.upload.headers["Cache-Control"],
					"Content-Disposition":
						authorization.upload.headers["Content-Disposition"],
					"Content-Length": authorization.upload.headers["Content-Length"],
					"Content-Type": authorization.upload.headers["Content-Type"],
				},
				method: authorization.upload.method,
			});
		} catch {
			lastStatus = 0;
			continue;
		}
		if (response.ok) return authorization;
		lastStatus = response.status;
	}
	const reason = lastStatus === 0 ? "network error" : `HTTP ${lastStatus}`;
	throw new CliError(`R2 upload failed after one retry: ${reason}`);
}

function headerEquals(
	response: Response,
	name: string,
	expected: string,
): void {
	const actual = response.headers.get(name);
	if (actual !== expected) {
		throw new CliError(`Public verification failed: ${name} did not match`);
	}
}

async function verifyPublicUpload(
	authorization: UploadAuthorization,
	bytes: number,
	dependencies: CliDependencies,
): Promise<void> {
	let response: Response | undefined;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			response = await dependencies.fetch(authorization.publicUrl, {
				method: "HEAD",
				redirect: "error",
			});
		} catch {
			if (attempt === 2)
				throw new CliError("Public verification failed: network error");
			await dependencies.sleep(250 * 2 ** attempt);
			continue;
		}
		if (response.status >= 500 && attempt < 2) {
			await dependencies.sleep(250 * 2 ** attempt);
			continue;
		}
		break;
	}
	if (!response?.ok) {
		throw new CliError(
			`Public verification failed: HTTP ${response?.status ?? 0}`,
		);
	}

	const expectedHeaders = authorization.upload.headers;
	headerEquals(response, "Cache-Control", CACHE_CONTROL);
	headerEquals(response, "Content-Type", expectedHeaders["Content-Type"]);
	headerEquals(
		response,
		"Content-Disposition",
		expectedHeaders["Content-Disposition"],
	);
	if (response.headers.get("X-Content-Type-Options") !== "nosniff") {
		throw new CliError(
			"Public verification failed: files.drsh4dow.dev is missing X-Content-Type-Options: nosniff. Deploy the Dumpfile nosniff Response Header Transform Rule and retry.",
		);
	}
	headerEquals(response, "Content-Length", String(bytes));
}

function sanitizedExtension(path: string): string {
	const extension = extname(basename(path)).slice(1).toLowerCase();
	return /^[a-z0-9]{1,16}$/.test(extension) ? extension : "";
}

function parseArguments(argv: readonly string[]): {
	json: boolean;
	path: string;
} {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		throw new CliError(usage);
	}
	if (argv[0] !== "upload") throw new CliError(usage);
	const rest = argv.slice(1);
	const json = rest.includes("--json");
	const paths = rest.filter((argument) => argument !== "--json");
	const path = paths[0];
	if (paths.length !== 1 || path === undefined || path.startsWith("-")) {
		throw new CliError(usage);
	}
	return { json, path: resolve(path) };
}

export async function upload(
	path: string,
	dependencies: CliDependencies,
): Promise<UploadResult> {
	const file = await stat(path);
	if (!file.isFile()) throw new CliError(`${path} is not a regular file`);
	if (file.size > MAX_UPLOAD_BYTES) {
		throw new CliError(
			"The direct upload transport supports files up to 5 GiB",
		);
	}

	const extension = sanitizedExtension(path);
	const contentType = contentTypeForExtension(extension);
	const request = { contentType, extension, size: file.size };
	const config = await readConfig(dependencies.env);
	dependencies.stderr.write("Authorizing upload...\n");
	const authorization = await uploadWithOneRetry(
		config,
		request,
		path,
		dependencies,
	);
	dependencies.stderr.write("Verifying public file...\n");
	await verifyPublicUpload(authorization, file.size, dependencies);
	return {
		bytes: file.size,
		contentType,
		key: authorization.key,
		url: authorization.publicUrl,
		verified: true,
	};
}

const defaultDependencies: CliDependencies = {
	env: process.env,
	fetch,
	fileBody: (path) => Bun.file(path),
	sleep: (milliseconds) =>
		new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
	stderr: process.stderr,
	stdout: process.stdout,
};

export async function main(
	argv: readonly string[],
	overrides: Partial<CliDependencies> = {},
): Promise<number> {
	const dependencies = { ...defaultDependencies, ...overrides };
	try {
		if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
			dependencies.stdout.write(`${usage}\n`);
			return 0;
		}
		const arguments_ = parseArguments(argv);
		const result = await upload(arguments_.path, dependencies);
		dependencies.stdout.write(
			arguments_.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`,
		);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		dependencies.stderr.write(`${message}\n`);
		return 1;
	}
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	process.exitCode = await main(process.argv.slice(2));
}
