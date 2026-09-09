import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	Clock,
	Data,
	DateTime,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
} from "effect";
import type { CodexAccount } from "./accounts.ts";

const WEEK_SECONDS = 7 * 24 * 60 * 60;
export const CACHE_TTL_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = LOCK_STALE_MS * 2;
const NETWORK_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 60_000;
const AUTH_TIMEOUT_MS = 15_000;
const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
let lockSequence = 0;
class UsageError extends Data.TaggedError("CodexUsageError")<{
	message: string;
}> {}
const usageError = (error: unknown) =>
	new UsageError({
		message: error instanceof Error ? error.message : String(error),
	});

export type UsageReading = typeof UsageReadingSchema.Type;
export type UsageCache = Record<string, UsageReading>;
const Percentage = Schema.Finite.check(
	Schema.isBetween({ minimum: 0, maximum: 100 }),
);
const ResetSeconds = Schema.Finite.check(
	Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000 }),
);

const FailureFields = {
	error: Schema.optional(Schema.String),
	retryAt: Schema.optional(Schema.Finite),
	failures: Schema.optional(Schema.Int),
};
const WindowSchema = Schema.Struct({
	usedPercent: Percentage,
	resetAt: ResetSeconds,
});
const UsageReadingSchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("known"),
		fetchedAt: Schema.Finite,
		weekly: WindowSchema,
		accountId: Schema.optional(Schema.String),
		...FailureFields,
	}),
	Schema.Struct({
		kind: Schema.Literal("error"),
		fetchedAt: Schema.Finite,
		accountId: Schema.optional(Schema.String),
		error: Schema.String,
		retryAt: Schema.optional(Schema.Finite),
		failures: Schema.optional(Schema.Int),
	}),
]);
const UsageCacheSchema = Schema.Record(Schema.String, UsageReadingSchema);
const UsageCacheJsonSchema = Schema.fromJsonString(UsageCacheSchema);
const RateWindowSchema = Schema.Struct({
	used_percent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	limit_window_seconds: Schema.Finite,
	reset_at: ResetSeconds,
});
const UsageResponseSchema = Schema.Struct({
	rate_limit: Schema.Struct({
		primary_window: Schema.optional(Schema.NullOr(RateWindowSchema)),
		secondary_window: Schema.optional(Schema.NullOr(RateWindowSchema)),
	}),
});
const PassiveWindowSchema = Schema.Struct({
	usedPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
	windowMinutes: Schema.Finite,
	resetAt: ResetSeconds,
});

type Fetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export function parseUsageResponse(
	value: unknown,
	fetchedAt: number,
): UsageReading {
	let parsed: Schema.Schema.Type<typeof UsageResponseSchema>;
	try {
		parsed = Schema.decodeUnknownSync(UsageResponseSchema)(value);
	} catch {
		return { kind: "error", fetchedAt, error: "Weekly usage was unavailable." };
	}
	const weekly = [
		parsed.rate_limit.primary_window,
		parsed.rate_limit.secondary_window,
	].find((item) => item?.limit_window_seconds === WEEK_SECONDS);
	if (!weekly)
		return { kind: "error", fetchedAt, error: "Weekly usage was unavailable." };
	return {
		kind: "known",
		fetchedAt,
		weekly: {
			usedPercent: Math.max(0, Math.min(100, weekly.used_percent)),
			resetAt: weekly.reset_at,
		},
	};
}

export function parsePassiveHeaders(
	headers: Headers,
	fetchedAt: number,
): UsageReading | undefined {
	for (const name of ["primary", "secondary"]) {
		const usedPercent = headers.get(`x-codex-${name}-used-percent`);
		const windowMinutes = headers.get(`x-codex-${name}-window-minutes`);
		const resetAt = headers.get(`x-codex-${name}-reset-at`);
		if (!usedPercent?.trim() || !windowMinutes?.trim() || !resetAt?.trim())
			continue;
		try {
			const decoded = Schema.decodeSync(PassiveWindowSchema)({
				usedPercent: Number(usedPercent),
				windowMinutes: Number(windowMinutes),
				resetAt: Number(resetAt),
			});
			if (decoded.windowMinutes !== WEEK_SECONDS / 60) continue;
			return {
				kind: "known",
				fetchedAt,
				weekly: {
					usedPercent: Math.max(0, Math.min(100, decoded.usedPercent)),
					resetAt: decoded.resetAt,
				},
			};
		} catch {
			// Try the other window.
		}
	}
	return undefined;
}

export function formatUsage(
	accounts: readonly CodexAccount[],
	cache: UsageCache,
	pinnedLabel: string | undefined,
	now: number,
): string {
	return accounts
		.map((account) => {
			const reading = cache[account.label];
			const current = pinnedLabel === account.label ? " [current]" : "";
			if (!reading) return `${account.label}${current}: unknown`;
			const age = Math.max(0, Math.floor((now - reading.fetchedAt) / 1000));
			if (reading.kind === "error")
				return `${account.label}${current}: error: ${reading.error} (${age}s old)`;
			const remaining = Math.max(0, 100 - reading.weekly.usedPercent);
			const reset = DateTime.formatIso(
				DateTime.makeUnsafe(reading.weekly.resetAt * 1000),
			);
			const error = reading.error ? `; refresh error: ${reading.error}` : "";
			return `${account.label}${current}: ${remaining.toFixed(1)}% weekly remaining, resets ${reset} (${age}s old)${error}`;
		})
		.join("\n");
}

export function selectAccount(
	accounts: readonly CodexAccount[],
	cache: UsageCache,
	now: number,
): CodexAccount | undefined {
	return accounts
		.filter((account) => {
			const reading = cache[account.label];
			return (
				reading?.kind === "known" &&
				reading.accountId !== undefined &&
				!reading.error &&
				now >= reading.fetchedAt &&
				now - reading.fetchedAt <= CACHE_TTL_MS &&
				reading.weekly.usedPercent < 100 &&
				reading.weekly.resetAt * 1000 > now
			);
		})
		.sort((a, b) => {
			const aReading = cache[a.label];
			const bReading = cache[b.label];
			if (aReading?.kind !== "known" || bReading?.kind !== "known") return 0;
			return (
				aReading.weekly.usedPercent - bReading.weekly.usedPercent ||
				a.label.localeCompare(b.label)
			);
		})[0];
}

const readCacheEffect = Effect.fn("readCache")(function* (cachePath: string) {
	const fs = yield* FileSystem.FileSystem;
	if (!(yield* fs.exists(cachePath))) return {};
	const content = yield* fs.readFileString(cachePath);
	const decoded = yield* Schema.decodeEffect(UsageCacheJsonSchema)(
		content,
	).pipe(Effect.orElseSucceed(() => ({})));
	return { ...decoded };
});

export function readCache(cachePath: string): Promise<UsageCache> {
	return Effect.runPromise(
		readCacheEffect(cachePath).pipe(Effect.provide(platformLayer)),
	);
}

const writeCache = Effect.fn("writeCache")(function* (
	cachePath: string,
	cache: UsageCache,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
	const temporary = `${cachePath}.${process.pid}.${lockSequence++}.tmp`;
	const content =
		yield* Schema.encodeUnknownEffect(UsageCacheJsonSchema)(cache);
	yield* fs.writeFileString(temporary, `${content}\n`, { mode: 0o600 });
	yield* fs.rename(temporary, cachePath);
});

const acquireLock = Effect.fn("acquireLock")(function* (cachePath: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const lock = `${cachePath}.lock`;
	yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });
	const startedAt = yield* Clock.currentTimeMillis;
	const token = `${process.pid}:${startedAt}:${lockSequence++}`;
	for (;;) {
		const now = yield* Clock.currentTimeMillis;
		if (now - startedAt > LOCK_WAIT_MS)
			return yield* new UsageError({
				message: "Timed out waiting for the Codex usage cache lock.",
			});
		const acquired = yield* fs.makeDirectory(lock).pipe(
			Effect.as(true),
			Effect.catchIf(
				(error) => error.reason._tag === "AlreadyExists",
				() => Effect.succeed(false),
			),
		);
		if (acquired) {
			yield* fs
				.writeFileString(`${lock}/owner`, token)
				.pipe(
					Effect.onError(() =>
						fs
							.remove(lock, { recursive: true, force: true })
							.pipe(Effect.ignore),
					),
				);
			return Effect.fn("releaseUsageLock")(function* () {
				const owner = yield* fs
					.readFileString(`${lock}/owner`)
					.pipe(Effect.orElseSucceed(() => undefined));
				if (owner === token)
					yield* fs.remove(lock, { recursive: true, force: true });
			});
		}
		const info = yield* fs
			.stat(lock)
			.pipe(Effect.orElseSucceed(() => undefined));
		const modifiedAt = info ? Option.getOrUndefined(info.mtime) : undefined;
		if (modifiedAt && now - modifiedAt.getTime() > LOCK_STALE_MS) {
			const abandoned = `${lock}.abandoned.${token}`;
			const moved = yield* fs.rename(lock, abandoned).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (moved) yield* fs.remove(abandoned, { recursive: true, force: true });
			continue;
		}
		yield* Effect.sleep(50);
	}
});

function responseRetryAt(response: Response, now: number): number | undefined {
	const value = response.headers.get("retry-after");
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
	const date = Date.parse(value);
	return Number.isFinite(date) ? date : undefined;
}

function failedReading(
	current: UsageReading | undefined,
	now: number,
	error: string,
	serverRetryAt?: number,
): UsageReading {
	const failures = (current?.failures ?? 0) + 1;
	const retryAt = Math.max(
		serverRetryAt ?? 0,
		now + Math.min(CACHE_TTL_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)),
	);
	if (current?.kind === "known")
		return { ...current, error, retryAt, failures };
	return { kind: "error", fetchedAt: now, error, retryAt, failures };
}

const refreshAccountUsageEffect = Effect.fn("refreshAccountUsage")(
	function* (options: {
		account: CodexAccount;
		cachePath: string;
		auth: () => Promise<{ apiKey: string; accountId: string }>;
		fetch?: Fetch;
		now?: () => number;
	}) {
		const release = yield* acquireLock(options.cachePath);
		return yield* Effect.gen(function* () {
			const cache = yield* readCacheEffect(options.cachePath);
			const now = options.now?.() ?? (yield* Clock.currentTimeMillis);
			const current = cache[options.account.label];
			if (
				current?.error &&
				current.retryAt !== undefined &&
				current.retryAt > now
			)
				return cache;
			const authResult = yield* Effect.tryPromise({
				try: options.auth,
				catch: usageError,
			}).pipe(
				Effect.timeout(AUTH_TIMEOUT_MS),
				Effect.map((auth) => ({ auth, error: undefined })),
				Effect.catch((error) =>
					Effect.succeed({
						auth: undefined,
						error: error instanceof Error ? error.message : String(error),
					}),
				),
			);
			if (!authResult.auth) {
				cache[options.account.label] = failedReading(
					current,
					now,
					authResult.error ?? "Authentication failed.",
				);
				yield* writeCache(options.cachePath, cache);
				return cache;
			}
			const auth = authResult.auth;
			if (
				current?.kind === "known" &&
				current.accountId === auth.accountId &&
				!current.error &&
				now >= current.fetchedAt &&
				now - current.fetchedAt <= CACHE_TTL_MS &&
				current.weekly.resetAt * 1000 > now
			)
				return cache;
			const matchingCurrent =
				current?.accountId === auth.accountId ? current : undefined;

			// Keep fetch and body consumption in one cancellable operation. Cancelling
			// an already-locked Response.body directly would reject instead of aborting.
			const attempt = Effect.tryPromise({
				try: (signal) =>
					(options.fetch ?? fetch)(
						"https://chatgpt.com/backend-api/wham/usage",
						{
							headers: {
								Authorization: `Bearer ${auth.apiKey}`,
								"ChatGPT-Account-Id": auth.accountId,
							},
							signal,
						},
					).then((response): Promise<UsageReading> => {
						if (!response.ok)
							return (response.body?.cancel() ?? Promise.resolve()).then(
								() => ({
									kind: "error",
									fetchedAt: now,
									error: `Usage request failed (${response.status}).`,
									retryAt: responseRetryAt(response, now),
								}),
							);
						return response
							.json()
							.then((value: unknown) => parseUsageResponse(value, now));
					}),
				catch: usageError,
			}).pipe(
				Effect.timeout(NETWORK_TIMEOUT_MS),
				Effect.catch((error) =>
					Effect.succeed({
						kind: "error" as const,
						fetchedAt: now,
						error: error instanceof Error ? error.message : String(error),
						retryAt: undefined,
					}),
				),
			);
			const result = yield* attempt;
			cache[options.account.label] =
				result.kind === "known"
					? { ...result, accountId: auth.accountId }
					: {
							...failedReading(
								matchingCurrent,
								now,
								result.error ?? "Usage request failed.",
								result.retryAt,
							),
							accountId: auth.accountId,
						};
			yield* writeCache(options.cachePath, cache);
			return cache;
		}).pipe(Effect.ensuring(release().pipe(Effect.ignore)));
	},
);

export function refreshAccountUsage(
	options: Parameters<typeof refreshAccountUsageEffect>[0],
): Promise<UsageCache> {
	return Effect.runPromise(
		refreshAccountUsageEffect(options).pipe(Effect.provide(platformLayer)),
	);
}

const updatePassiveUsageEffect = Effect.fn("updatePassiveUsage")(function* (
	cachePath: string,
	label: string,
	accountId: string,
	reading: UsageReading,
) {
	const release = yield* acquireLock(cachePath);
	yield* Effect.gen(function* () {
		const cache = yield* readCacheEffect(cachePath);
		cache[label] = { ...reading, accountId };
		yield* writeCache(cachePath, cache);
	}).pipe(Effect.ensuring(release().pipe(Effect.ignore)));
});

export function updatePassiveUsage(
	cachePath: string,
	label: string,
	accountId: string,
	reading: UsageReading,
): Promise<void> {
	return Effect.runPromise(
		updatePassiveUsageEffect(cachePath, label, accountId, reading).pipe(
			Effect.provide(platformLayer),
		),
	);
}
