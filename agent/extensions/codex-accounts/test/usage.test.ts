import assert from "node:assert/strict";
import test from "node:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem } from "effect";
import {
	CACHE_TTL_MS,
	formatUsage,
	parsePassiveHeaders,
	parseUsageResponse,
	readCache,
	refreshAccountUsage,
	selectAccount,
	updatePassiveUsage,
} from "../usage.ts";

const now = 1_800_000_000_000;
const resetAt = now / 1000 + 3600;
const account = { label: "alpha", provider: "openai-codex@alpha" };
const auth = () =>
	Promise.resolve({ apiKey: "test-key", accountId: "test-account" });
const usageResponse = (usedPercent: number) =>
	new Response(
		JSON.stringify({
			rate_limit: {
				primary_window: {
					used_percent: usedPercent,
					limit_window_seconds: 604_800,
					reset_at: resetAt,
				},
			},
		}),
		{ status: 200 },
	);

const runFileSystem = <A, E>(
	effect: Effect.Effect<A, E, FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(BunFileSystem.layer)));
const writeFile = (path: string, content: string) =>
	runFileSystem(
		FileSystem.FileSystem.use((fs) => fs.writeFileString(path, content)),
	);
const readFile = (path: string) =>
	runFileSystem(FileSystem.FileSystem.use((fs) => fs.readFileString(path)));

function withCache(run: (cachePath: string) => Promise<void>): Promise<void> {
	return runFileSystem(
		FileSystem.FileSystem.use((fs) =>
			fs.makeTempDirectory({ prefix: "codex-usage-" }),
		),
	).then((directory) =>
		run(`${directory}/usage.json`).finally(() =>
			runFileSystem(
				FileSystem.FileSystem.use((fs) =>
					fs.remove(directory, { recursive: true, force: true }),
				),
			),
		),
	);
}

test("selects the highest fresh weekly allowance and breaks ties by label", () => {
	const accounts = [
		{ label: "zeta", provider: "zeta" },
		{ label: "alpha", provider: "alpha" },
		{ label: "spent", provider: "spent" },
		{ label: "unknown", provider: "unknown" },
	];
	const cache = {
		alpha: {
			kind: "known" as const,
			fetchedAt: now,
			accountId: "a",
			weekly: { usedPercent: 20, resetAt },
		},
		zeta: {
			kind: "known" as const,
			fetchedAt: now,
			accountId: "z",
			weekly: { usedPercent: 20, resetAt },
		},
		spent: {
			kind: "known" as const,
			fetchedAt: now,
			accountId: "s",
			weekly: { usedPercent: 100, resetAt },
		},
	};
	assert.equal(selectAccount(accounts, cache, now)?.label, "alpha");
});

test("expired and stale weekly readings are ineligible", () => {
	const accounts = [
		{ label: "expired", provider: "expired" },
		{ label: "stale", provider: "stale" },
	];
	const cache = {
		expired: {
			kind: "known" as const,
			fetchedAt: now,
			accountId: "e",
			weekly: { usedPercent: 0, resetAt: now / 1000 - 1 },
		},
		stale: {
			kind: "known" as const,
			fetchedAt: now - CACHE_TTL_MS - 1,
			accountId: "s",
			weekly: { usedPercent: 0, resetAt },
		},
	};
	assert.equal(selectAccount(accounts, cache, now), undefined);
});

test("finds the weekly window by duration rather than response position", () => {
	assert.deepEqual(
		parseUsageResponse(
			{
				rate_limit: {
					primary_window: {
						used_percent: 90,
						limit_window_seconds: 18_000,
						reset_at: resetAt,
					},
					secondary_window: {
						used_percent: 25,
						limit_window_seconds: 604_800,
						reset_at: resetAt,
					},
				},
			},
			now,
		),
		{ kind: "known", fetchedAt: now, weekly: { usedPercent: 25, resetAt } },
	);
});

test("accepts complete passive weekly headers and rejects partial or malformed values", () => {
	assert.deepEqual(
		parsePassiveHeaders(
			new Headers({
				"x-codex-primary-used-percent": "35",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-at": String(resetAt),
			}),
			now,
		),
		{ kind: "known", fetchedAt: now, weekly: { usedPercent: 35, resetAt } },
	);
	assert.equal(
		parsePassiveHeaders(
			new Headers({
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-at": String(resetAt),
			}),
			now,
		),
		undefined,
	);
	assert.equal(
		parsePassiveHeaders(
			new Headers({
				"x-codex-primary-used-percent": "nope",
				"x-codex-primary-window-minutes": "10080",
				"x-codex-primary-reset-at": String(resetAt),
			}),
			now,
		),
		undefined,
	);
});

test("uses a fresh disk cache without networking", () =>
	withCache((cachePath) =>
		updatePassiveUsage(cachePath, account.label, "test-account", {
			kind: "known",
			fetchedAt: now,
			weekly: { usedPercent: 30, resetAt },
		}).then(() => {
			let calls = 0;
			return refreshAccountUsage({
				account,
				cachePath,
				now: () => now + 1,
				auth: () => {
					calls++;
					return auth();
				},
				fetch: () => {
					calls++;
					return Promise.resolve(usageResponse(90));
				},
			}).then((cache) => {
				assert.equal(
					cache.alpha?.kind === "known"
						? cache.alpha.weekly.usedPercent
						: undefined,
					30,
				);
				assert.equal(calls, 1);
			});
		}),
	));

test("refreshes a fresh label cache after the credential changes account identity", () =>
	withCache((cachePath) =>
		updatePassiveUsage(cachePath, account.label, "old-account", {
			kind: "known",
			fetchedAt: now,
			weekly: { usedPercent: 5, resetAt },
		})
			.then(() =>
				refreshAccountUsage({
					account,
					cachePath,
					now: () => now + 1,
					auth: () =>
						Promise.resolve({ apiKey: "new-key", accountId: "new-account" }),
					fetch: () => Promise.resolve(usageResponse(45)),
				}),
			)
			.then((cache) => {
				assert.equal(cache.alpha?.accountId, "new-account");
				assert.equal(
					cache.alpha?.kind === "known"
						? cache.alpha.weekly.usedPercent
						: undefined,
					45,
				);
			}),
	));

test("coalesces concurrent stale readers behind the disk lock", () =>
	withCache((cachePath) => {
		let fetches = 0;
		const fetchUsage = () => {
			fetches++;
			return Promise.resolve(usageResponse(40));
		};
		const options = {
			account,
			cachePath,
			now: () => now,
			auth,
			fetch: fetchUsage,
		};
		return Promise.all([
			refreshAccountUsage(options),
			refreshAccountUsage(options),
			refreshAccountUsage(options),
		]).then((caches) => {
			assert.equal(fetches, 1);
			assert.deepEqual(
				caches.map((cache) =>
					cache.alpha?.kind === "known"
						? cache.alpha.weekly.usedPercent
						: undefined,
				),
				[40, 40, 40],
			);
		});
	}));

test("keeps a stale successful reading visible after failure and backs off retries", () =>
	withCache((cachePath) => {
		const staleAt = now - CACHE_TTL_MS - 1;
		let fetches = 0;
		const failingFetch = () => {
			fetches++;
			return Promise.resolve(new Response("", { status: 503 }));
		};
		return updatePassiveUsage(cachePath, account.label, "test-account", {
			kind: "known",
			fetchedAt: staleAt,
			weekly: { usedPercent: 25, resetAt },
		})
			.then(() =>
				refreshAccountUsage({
					account,
					cachePath,
					now: () => now,
					auth,
					fetch: failingFetch,
				}),
			)
			.then((failed) => {
				assert.deepEqual(failed.alpha, {
					kind: "known",
					fetchedAt: staleAt,
					weekly: { usedPercent: 25, resetAt },
					accountId: "test-account",
					error: "Usage request failed (503).",
					retryAt: now + 60_000,
					failures: 1,
				});
				assert.equal(selectAccount([account], failed, now), undefined);
				assert.match(
					formatUsage([account], failed, undefined, now),
					/75\.0% weekly remaining.*refresh error: Usage request failed \(503\)\./,
				);
				return refreshAccountUsage({
					account,
					cachePath,
					now: () => now + 59_999,
					auth,
					fetch: failingFetch,
				});
			})
			.then(() => {
				assert.equal(fetches, 1);
				return refreshAccountUsage({
					account,
					cachePath,
					now: () => now + 60_000,
					auth,
					fetch: () => Promise.resolve(usageResponse(10)),
				});
			})
			.then((recovered) => {
				assert.equal(
					recovered.alpha?.kind === "known"
						? recovered.alpha.weekly.usedPercent
						: undefined,
					10,
				);
				assert.equal(recovered.alpha?.error, undefined);
			});
	}));

test("honors Retry-After before retrying", () =>
	withCache((cachePath) => {
		let fetches = 0;
		const limited = () => {
			fetches++;
			return Promise.resolve(
				new Response("", { status: 429, headers: { "retry-after": "60" } }),
			);
		};
		return refreshAccountUsage({
			account,
			cachePath,
			now: () => now,
			auth,
			fetch: limited,
		})
			.then((first) => {
				assert.equal(first.alpha?.retryAt, now + 60_000);
				return refreshAccountUsage({
					account,
					cachePath,
					now: () => now + 59_999,
					auth,
					fetch: limited,
				});
			})
			.then(() => assert.equal(fetches, 1));
	}));

test("recovers an abandoned lock and rejects malformed cache schema", () =>
	withCache((cachePath) =>
		writeFile(cachePath, '{"alpha":{"kind":"known","fetchedAt":"bad"}}\n')
			.then(() => readCache(cachePath))
			.then((cache) => assert.deepEqual(cache, {}))
			.then(() =>
				runFileSystem(
					FileSystem.FileSystem.use((fs) =>
						fs.makeDirectory(`${cachePath}.lock`),
					),
				),
			)
			.then(() => writeFile(`${cachePath}.lock/owner`, "dead"))
			.then(() =>
				runFileSystem(
					FileSystem.FileSystem.use((fs) =>
						fs.utimes(`${cachePath}.lock`, 0, 0),
					),
				),
			)
			.then(() =>
				refreshAccountUsage({
					account,
					cachePath,
					now: () => now,
					auth,
					fetch: () => Promise.resolve(usageResponse(15)),
				}),
			)
			.then((cache) => {
				assert.equal(
					cache.alpha?.kind === "known"
						? cache.alpha.weekly.usedPercent
						: undefined,
					15,
				);
				return readFile(cachePath);
			})
			.then((content) => assert.match(content, /"usedPercent":15/)),
	));
