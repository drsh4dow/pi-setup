import { isDeepStrictEqual } from "node:util";
import { BUCKET_NAME } from "./contract.ts";

const rule = {
	id: "dumpfile-expire-30-days",
	enabled: true,
	conditions: { prefix: "" },
	deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86400 } },
};

interface Runtime {
	readonly auth: string;
	readonly fetch: typeof fetch;
	readonly write: (text: string) => void;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function main(
	args: readonly string[],
	runtime: Runtime,
): Promise<number> {
	const [mode, account, approval] = args;
	if (
		!account ||
		!/^[a-f0-9]{32}$/.test(account) ||
		!(
			(mode === "check" && args.length === 2) ||
			(mode === "apply" &&
				args.length === 3 &&
				approval === "--expire-existing-uploads")
		)
	) {
		runtime.write(
			"Usage: retention.ts check <account-id> | apply <account-id> --expire-existing-uploads\nApply authorizes expiration of ALL existing and future dumpfile-prod objects after 30 days of object age.\n",
		);
		return 1;
	}
	try {
		const auth: unknown = JSON.parse(runtime.auth);
		if (
			!record(auth) ||
			(auth.type !== "oauth" && auth.type !== "api_token") ||
			typeof auth.token !== "string" ||
			!auth.token
		) {
			runtime.write(
				"Supply Wrangler auth token --json on stdin; API key authentication is unsupported.\n",
			);
			return 1;
		}
		const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET_NAME}/lifecycle`;
		const headers = {
			Authorization: `Bearer ${auth.token}`,
			"Content-Type": "application/json",
			"cf-r2-data-catalog-check": "true",
		};
		async function readRules(): Promise<Record<string, unknown>[]> {
			const response = await runtime.fetch(url, { method: "GET", headers });
			const body: unknown = await response.json();
			if (
				!response.ok ||
				!record(body) ||
				body.success !== true ||
				!record(body.result) ||
				!Array.isArray(body.result.rules)
			) {
				throw new Error("Could not read lifecycle configuration");
			}
			const rules: Record<string, unknown>[] = [];
			for (const item of body.result.rules) {
				if (
					!record(item) ||
					typeof item.id !== "string" ||
					typeof item.enabled !== "boolean" ||
					!record(item.conditions)
				)
					throw new Error("Invalid lifecycle rule");
				rules.push(item);
			}
			return rules;
		}
		let rules = await readRules();
		const expected = [...rules.filter((item) => item.id !== rule.id), rule];
		const configured = rules.filter((item) => item.id === rule.id);
		if (mode === "apply" && !isDeepStrictEqual(configured, [rule])) {
			const response = await runtime.fetch(url, {
				method: "PUT",
				headers,
				body: JSON.stringify({ rules: expected }),
			});
			const body: unknown = await response.json();
			if (!response.ok || !record(body) || body.success !== true)
				throw new Error("Could not apply lifecycle configuration");
			rules = await readRules();
			if (!isDeepStrictEqual(rules, expected))
				throw new Error(
					"Lifecycle read-back differs from applied configuration",
				);
		}
		const matches = isDeepStrictEqual(
			rules.filter((item) => item.id === rule.id),
			[rule],
		);
		runtime.write(
			matches
				? "30-day lifecycle configured. Expiry is asynchronous.\n"
				: "30-day lifecycle not configured.\n",
		);
		if (
			rules.some(
				(item) =>
					item.id !== rule.id &&
					item.enabled === true &&
					item.deleteObjectsTransition !== undefined,
			)
		) {
			runtime.write(
				"Other expiration rules remain; review their prefixes and ages for earlier deletion.\n",
			);
		}
		return matches ? 0 : 1;
	} catch {
		// API errors can contain credentials; never echo transport messages or bodies.
		runtime.write(
			"Retention operation failed; check Wrangler credentials, API availability, and lifecycle configuration. No deployment is verified.\n",
		);
		return 1;
	}
}

if (import.meta.main) {
	let auth = "";
	for await (const chunk of process.stdin) auth += chunk;
	process.exitCode = await main(process.argv.slice(2), {
		auth,
		fetch,
		write: (text) => process.stdout.write(text),
	});
}
