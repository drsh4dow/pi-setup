import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { main } from "../src/cli.ts";
import { CACHE_CONTROL } from "../src/contract.ts";

interface Harness {
	readonly config: string;
	readonly directory: string;
	readonly stderr: string[];
	readonly stdout: string[];
}

interface TestAuthorization {
	readonly key: string;
	readonly publicUrl: string;
	readonly upload: {
		readonly expiresAt: string;
		readonly headers: Readonly<Record<string, string>>;
		readonly method: string;
		readonly url: string;
	};
}

async function harness(t: TestContext): Promise<Harness> {
	const directory = await mkdtemp(join(tmpdir(), "dumpfile-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = join(directory, "config.env");
	await writeFile(
		config,
		"DUMPFILE_API_URL=https://upload.drsh4dow.dev\nDUMPFILE_R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef\nDUMPFILE_TOKEN=local-secret-token\n",
		{ mode: 0o600 },
	);
	return { config, directory, stderr: [], stdout: [] };
}

function authorization(
	contentType = "image/png",
	disposition = "inline",
	suffix = "00000000000000000000000000000001",
	bytes = 11,
): TestAuthorization {
	return {
		key: `2026/08/21/${suffix}.png`,
		publicUrl: `https://files.drsh4dow.dev/2026/08/21/${suffix}.png`,
		upload: {
			expiresAt: "2026-08-21T12:05:00.000Z",
			headers: {
				"Cache-Control": CACHE_CONTROL,
				"Content-Disposition": disposition,
				"Content-Length": String(bytes),
				"Content-Type": contentType,
			},
			method: "PUT",
			url: `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/dumpfile-prod/2026/08/21/${suffix}.png?X-Amz-Signature=${suffix}`,
		},
	};
}

function headResponse(
	bytes: number,
	contentType = "image/png",
	disposition = "inline",
): Response {
	return new Response(null, {
		headers: {
			"Cache-Control": CACHE_CONTROL,
			"Content-Disposition": disposition,
			"Content-Length": String(bytes),
			"Content-Type": contentType,
			"X-Content-Type-Options": "nosniff",
		},
		status: 200,
	});
}

test("uploads a file, verifies public metadata, and prints only its URL", async (t) => {
	const state = await harness(t);
	const path = join(state.directory, "proof image.png");
	await writeFile(path, "png fixture");
	const requests: Array<{ init?: RequestInit; url: string }> = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		requests.push({ init, url });
		if (url.endsWith("/v1/uploads")) {
			return Response.json(authorization(), { status: 201 });
		}
		if (init?.method === "PUT") return new Response(null, { status: 200 });
		return headResponse(11);
	};

	const code = await main(["upload", path], {
		env: { DUMPFILE_CONFIG_FILE: state.config },
		fetch: fetcher,
		fileBody: () => new Blob(["png fixture"]),
		sleep: async () => {},
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 0);
	assert.deepEqual(state.stdout, [
		"https://files.drsh4dow.dev/2026/08/21/00000000000000000000000000000001.png\n",
	]);
	assert.deepEqual(state.stderr, [
		"Authorizing upload...\n",
		"Verifying public file...\n",
	]);
	assert.equal(requests.length, 3);
	assert.deepEqual(requests[1]?.init?.headers, {
		"Cache-Control": CACHE_CONTROL,
		"Content-Disposition": "inline",
		"Content-Length": "11",
		"Content-Type": "image/png",
	});
	const signerBody = JSON.parse(String(requests[0]?.init?.body));
	assert.deepEqual(signerBody, {
		contentType: "image/png",
		extension: "png",
		size: 11,
	});
	assert.equal(
		new Headers(requests[0]?.init?.headers).get("Authorization"),
		"Bearer local-secret-token",
	);
	assert.equal(state.stdout.join("").includes("local-secret-token"), false);
	assert.equal(state.stderr.join("").includes("local-secret-token"), false);
});

test("uses a fresh authorization for the one allowed PUT retry", async (t) => {
	const state = await harness(t);
	const path = join(state.directory, "recording.webm");
	await writeFile(path, "video");
	let authorizations = 0;
	let puts = 0;
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.endsWith("/v1/uploads")) {
			authorizations += 1;
			return Response.json(
				authorization(
					"video/webm",
					"inline",
					String(authorizations).padStart(32, "0"),
					5,
				),
				{
					status: 201,
				},
			);
		}
		if (init?.method === "PUT") {
			puts += 1;
			return new Response(null, { status: puts === 1 ? 503 : 200 });
		}
		return headResponse(5, "video/webm");
	};
	const code = await main(["upload", path, "--json"], {
		env: { DUMPFILE_CONFIG_FILE: state.config },
		fetch: fetcher,
		fileBody: () => new Blob(["video"]),
		sleep: async () => {},
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 0);
	assert.equal(authorizations, 2);
	assert.equal(puts, 2);
	assert.deepEqual(JSON.parse(state.stdout.join("")), {
		bytes: 5,
		contentType: "video/webm",
		key: "2026/08/21/00000000000000000000000000000002.png",
		url: "https://files.drsh4dow.dev/2026/08/21/00000000000000000000000000000002.png",
		verified: true,
	});
});

test("uploads unknown extensions as forced downloads", async (t) => {
	const state = await harness(t);
	const path = join(state.directory, "archive.xyzzy");
	await writeFile(path, "archive");
	let signerRequest: Record<string, unknown> = {};
	const fetcher: typeof fetch = async (input, init) => {
		if (String(input).endsWith("/v1/uploads")) {
			signerRequest = JSON.parse(String(init?.body));
			return Response.json(
				authorization(
					"application/octet-stream",
					"attachment",
					"00000000000000000000000000000001",
					7,
				),
				{ status: 201 },
			);
		}
		if (init?.method === "PUT") return new Response(null, { status: 200 });
		return headResponse(7, "application/octet-stream", "attachment");
	};
	const code = await main(["upload", path], {
		env: { DUMPFILE_CONFIG_FILE: state.config },
		fetch: fetcher,
		fileBody: () => new Blob(["archive"]),
		sleep: async () => {},
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 0);
	assert.deepEqual(signerRequest, {
		contentType: "application/octet-stream",
		extension: "xyzzy",
		size: 7,
	});
});

test("rejects oversized files before reading configuration or contacting the service", async (t) => {
	const state = await harness(t);
	const path = join(state.directory, "huge.bin");
	await writeFile(path, "");
	await truncate(path, 5 * 1024 * 1024 * 1024 + 1);
	let contacted = false;
	const code = await main(["upload", path], {
		env: {},
		fetch: async () => {
			contacted = true;
			return new Response();
		},
		fileBody: () => new Blob(),
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 1);
	assert.equal(contacted, false);
	assert.match(state.stderr.join(""), /up to 5 GiB/);
});

test("rejects signer responses that redirect either public or upload bytes", async (t) => {
	const unsafeResponses = [
		{
			...authorization(
				"image/png",
				"inline",
				"00000000000000000000000000000001",
				5,
			),
			publicUrl: "https://attacker.example/proof.png",
		},
		{
			...authorization(
				"image/png",
				"inline",
				"00000000000000000000000000000001",
				5,
			),
			upload: {
				...authorization(
					"image/png",
					"inline",
					"00000000000000000000000000000001",
					5,
				).upload,
				url: "https://attacker.example/upload?X-Amz-Signature=stolen",
			},
		},
	];

	for (const unsafeResponse of unsafeResponses) {
		const state = await harness(t);
		const path = join(state.directory, "proof.png");
		await writeFile(path, "proof");
		let requests = 0;
		const code = await main(["upload", path], {
			env: { DUMPFILE_CONFIG_FILE: state.config },
			fetch: async () => {
				requests += 1;
				return Response.json(unsafeResponse, { status: 201 });
			},
			fileBody: () => new Blob(["proof"]),
			stderr: { write: (text) => state.stderr.push(text) },
			stdout: { write: (text) => state.stdout.push(text) },
		});
		assert.equal(code, 1);
		assert.equal(requests, 1);
		assert.match(state.stderr.join(""), /unexpected (publicUrl|R2 upload URL)/);
	}
});

test("requires Content-Length during public verification", async (t) => {
	const state = await harness(t);
	const path = join(state.directory, "proof.png");
	await writeFile(path, "proof");
	const fetcher: typeof fetch = async (input, init) => {
		if (String(input).endsWith("/v1/uploads")) {
			return Response.json(
				authorization(
					"image/png",
					"inline",
					"00000000000000000000000000000001",
					5,
				),
				{ status: 201 },
			);
		}
		if (init?.method === "PUT") return new Response(null, { status: 200 });
		const response = headResponse(5);
		response.headers.delete("Content-Length");
		return response;
	};
	const code = await main(["upload", path], {
		env: { DUMPFILE_CONFIG_FILE: state.config },
		fetch: fetcher,
		fileBody: () => new Blob(["proof"]),
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 1);
	assert.match(state.stderr.join(""), /Content-Length did not match/);
});

test("explains how to repair a missing public nosniff rule", async (t) => {
	const state = await harness(t);
	const path = join(state.directory, "proof.png");
	await writeFile(path, "proof");
	const fetcher: typeof fetch = async (input, init) => {
		if (String(input).endsWith("/v1/uploads")) {
			return Response.json(
				authorization(
					"image/png",
					"inline",
					"00000000000000000000000000000001",
					5,
				),
				{ status: 201 },
			);
		}
		if (init?.method === "PUT") return new Response(null, { status: 200 });
		const response = headResponse(5);
		response.headers.delete("X-Content-Type-Options");
		return response;
	};
	const code = await main(["upload", path], {
		env: { DUMPFILE_CONFIG_FILE: state.config },
		fetch: fetcher,
		fileBody: () => new Blob(["proof"]),
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 1);
	assert.match(state.stderr.join(""), /Response Header Transform Rule/);
	assert.match(state.stderr.join(""), /files\.drsh4dow\.dev/);
});

test("rejects a group-readable token file", async (t) => {
	const state = await harness(t);
	await chmod(state.config, 0o640);
	const path = join(state.directory, "proof.png");
	await writeFile(path, "proof");
	const code = await main(["upload", path], {
		env: { DUMPFILE_CONFIG_FILE: state.config },
		fileBody: () => new Blob(["proof"]),
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 1);
	assert.match(state.stderr.join(""), /mode 0600/);
});

test("never prints bearer tokens or presigned URLs on upload failure", async (t) => {
	const state = await harness(t);
	const path = join(state.directory, "proof.png");
	await writeFile(path, "proof");
	const fetcher: typeof fetch = async (input) => {
		if (String(input).endsWith("/v1/uploads")) {
			return Response.json(
				authorization(
					"image/png",
					"inline",
					"00000000000000000000000000000001",
					5,
				),
				{ status: 201 },
			);
		}
		return new Response("signed failure", { status: 403 });
	};
	const code = await main(["upload", path], {
		env: { DUMPFILE_CONFIG_FILE: state.config },
		fetch: fetcher,
		fileBody: () => new Blob(["proof"]),
		stderr: { write: (text) => state.stderr.push(text) },
		stdout: { write: (text) => state.stdout.push(text) },
	});
	assert.equal(code, 1);
	const output = `${state.stdout.join("")} ${state.stderr.join("")}`;
	assert.equal(output.includes("local-secret-token"), false);
	assert.equal(output.includes("X-Amz-Signature"), false);
	assert.match(output, /R2 upload failed after one retry/);
});
