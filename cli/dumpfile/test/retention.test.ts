import assert from "node:assert/strict";
import test from "node:test";
import { main } from "../src/retention.ts";

const account = "0123456789abcdef0123456789abcdef";
const auth = JSON.stringify({ type: "oauth", token: "synthetic-token" });
const unrelated = {
	id: "multipart-cleanup",
	enabled: true,
	conditions: { prefix: "" },
	abortMultipartUploadsTransition: {
		condition: { type: "Age", maxAge: 604800 },
	},
};

test("retention check is read-only and reports missing configuration", async () => {
	const output: string[] = [];
	const code = await main(["check", account], {
		auth,
		fetch: async (url, init) => {
			assert.equal(
				String(url),
				`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/dumpfile-prod/lifecycle`,
			);
			assert.equal(init?.method, "GET");
			return Response.json({ success: true, result: { rules: [unrelated] } });
		},
		write: (text) => output.push(text),
	});
	assert.equal(code, 1);
	assert.match(output.join(""), /not configured/);
});
const desired = {
	id: "dumpfile-expire-30-days",
	enabled: true,
	conditions: { prefix: "" },
	deleteObjectsTransition: { condition: { type: "Age", maxAge: 2592000 } },
};

test("apply requires explicit approval for existing uploads before any API access", async () => {
	const output: string[] = [];
	assert.equal(
		await main(["apply", account], {
			auth,
			fetch: async () => {
				assert.fail("unapproved API access");
			},
			write: (text) => output.push(text),
		}),
		1,
	);
	assert.match(output.join(""), /--expire-existing-uploads/);
});

test("approved apply preserves other rules, verifies remote state, and is idempotent", async () => {
	let rules: unknown[] = [unrelated, { ...desired, enabled: false }];
	let writes = 0;
	const runtime = {
		auth,
		fetch: (async (_url, init) => {
			if (init?.method === "PUT") {
				writes++;
				rules = JSON.parse(String(init.body)).rules;
				assert.deepEqual(rules, [unrelated, desired]);
				return Response.json({ success: true });
			}
			return Response.json({ success: true, result: { rules } });
		}) satisfies typeof fetch,
		write: (_text: string) => {},
	};
	assert.equal(
		await main(["apply", account, "--expire-existing-uploads"], runtime),
		0,
	);
	assert.equal(
		await main(["apply", account, "--expire-existing-uploads"], runtime),
		0,
	);
	assert.equal(writes, 1);
	assert.equal(await main(["check", account], runtime), 0);
});

test("first apply preserves unrelated deletion rules and reports their possible overlap", async () => {
	const other = {
		...desired,
		id: "expire-logs",
		conditions: { prefix: "logs/" },
	};
	let rules: unknown[] = [unrelated, other];
	const output: string[] = [];
	const code = await main(["apply", account, "--expire-existing-uploads"], {
		auth,
		fetch: async (_url, init) => {
			if (init?.method === "PUT") {
				rules = JSON.parse(String(init.body)).rules;
				assert.deepEqual(rules, [unrelated, other, desired]);
				return Response.json({ success: true });
			}
			return Response.json({ success: true, result: { rules } });
		},
		write: (text) => output.push(text),
	});
	assert.equal(code, 0);
	assert.match(output.join(""), /Other expiration rules remain/);
});

for (const failure of ["read", "malformed", "write", "read-back"]) {
	test(`retention fails closed on ${failure} failure without reporting deployment`, async () => {
		let writes = 0;
		const output: string[] = [];
		const code = await main(["apply", account, "--expire-existing-uploads"], {
			auth,
			fetch: async (_url, init) => {
				if (init?.method === "PUT") {
					writes++;
					return Response.json({ success: failure !== "write" });
				}
				if (failure === "read") throw new Error("synthetic-token");
				return Response.json({
					success: true,
					result: { rules: failure === "malformed" ? [null] : [unrelated] },
				});
			},
			write: (text) => output.push(text),
		});
		assert.equal(code, 1);
		assert.equal(writes, failure === "read" || failure === "malformed" ? 0 : 1);
		assert.match(output.join(""), /No deployment is verified/);
		assert.equal(output.join("").includes("synthetic-token"), false);
	});
}
