import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { refreshAccountUsage } from "../usage.ts";

const nativeFetch = Effect.runSync(FetchHttpClient.Fetch);
const [cachePath, endpoint] = process.argv.slice(2);
if (!cachePath || !endpoint)
	throw new Error("Expected cache path and loopback endpoint");
await refreshAccountUsage({
	account: { label: "A", provider: "openai-codex@A" },
	cachePath,
	auth: () =>
		Promise.resolve({ apiKey: "fixture", accountId: "fixture-account" }),
	fetch: (_input, init) => nativeFetch(endpoint, init),
}).then((cache) => {
	const reading = cache.A;
	process.stdout.write(
		String(
			reading?.kind === "known" ? reading.weekly.usedPercent : reading?.error,
		),
	);
});
