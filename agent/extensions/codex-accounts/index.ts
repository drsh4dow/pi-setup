import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	Clock,
	Data,
	Effect,
	FileSystem,
	Layer,
	ManagedRuntime,
	Path,
	Schema,
	Semaphore,
} from "effect";
import {
	accountIdFromToken,
	accountProvider,
	type CodexAccount,
	isCodexProvider,
	LOGICAL_PROVIDER,
	labelFromProvider,
	parseAccountLabels,
} from "./accounts.ts";
import {
	formatUsage,
	parsePassiveHeaders,
	readCache,
	refreshAccountUsage,
	selectAccount,
	updatePassiveUsage,
} from "./usage.ts";

const runtime = ManagedRuntime.make(
	Layer.mergeAll(BunFileSystem.layer, BunPath.layer),
);
class CodexAccountError extends Data.TaggedError("CodexAccountError")<{
	message: string;
}> {}
const accountFailure = (error: unknown) =>
	new CodexAccountError({
		message: error instanceof Error ? error.message : String(error),
	});
const PIN_ENTRY = "codex-account-pin";
const FRESH_ENTRY = "codex-account-fresh-session";
const isSessionMarker = Schema.is(Schema.Struct({ sessionId: Schema.String }));
const Pin = Schema.Struct({
	sessionId: Schema.String,
	provider: Schema.String,
	accountId: Schema.String,
});
type Pin = typeof Pin.Type;
const isPin = Schema.is(Pin);
const originalAccount: CodexAccount = {
	label: "original login",
	provider: LOGICAL_PROVIDER,
};

function savedPin(ctx: ExtensionContext): Pin | undefined {
	// A pin belongs to the session, not its current branch. Forked entries carry
	// the source session ID and cannot pin their new owner.
	return ctx.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === PIN_ENTRY &&
			isPin(entry.data) &&
			entry.data.sessionId === ctx.sessionManager.getSessionId()
				? [entry.data]
				: [],
		)
		.at(-1);
}

function legacyProvider(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			isCodexProvider(entry.message.provider)
				? [entry.message.provider]
				: [],
		)
		.at(-1);
}

const providerAuth = Effect.fn("codex.providerAuth")(function* (
	ctx: ExtensionContext,
	provider: string,
) {
	const result = yield* Effect.tryPromise({
		try: () => ctx.modelRegistry.getProviderAuth(provider),
		catch: accountFailure,
	});
	const apiKey = result?.auth.apiKey;
	if (!apiKey)
		return yield* new CodexAccountError({
			message: `Codex account ${provider} is not logged in. Run /login ${provider}.`,
		});
	const accountId = yield* Effect.try({
		try: () => accountIdFromToken(apiKey),
		catch: () =>
			new CodexAccountError({
				message: `Codex account ${provider} has no valid OAuth account identity. Reauthenticate it.`,
			}),
	});
	return { apiKey, accountId };
});

export default function codexAccounts(pi: ExtensionAPI): Promise<void> {
	return runtime.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const configPath = path.join(getAgentDir(), "codex-accounts.json");
			const cachePath = path.join(getAgentDir(), "codex-usage.json");
			// Configuration is parsed once per extension load; /reload applies edits.
			if (!(yield* fs.exists(configPath))) {
				yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
				yield* Effect.scoped(
					Effect.gen(function* () {
						const temporary = yield* fs.makeTempFileScoped({
							directory: path.dirname(configPath),
							prefix: ".codex-accounts-",
							suffix: ".tmp",
						});
						yield* fs.writeFileString(temporary, '{\n  "accounts": []\n}\n', {
							mode: 0o600,
						});
						// Publish complete contents without overwriting another startup or the user.
						yield* fs.link(temporary, configPath).pipe(
							Effect.catchIf(
								(error) => error.reason._tag === "AlreadyExists",
								() => Effect.void,
							),
						);
					}),
				);
			}
			const text = yield* fs.readFileString(configPath);
			const config = yield* Schema.decodeEffect(
				Schema.fromJsonString(Schema.Unknown),
			)(text);
			const accounts = yield* Effect.try({
				try: () => parseAccountLabels(config),
				catch: accountFailure,
			});
			let pin: Pin | undefined;
			let previousProvider: string | undefined;
			let switching = false;

			const refreshAll = Effect.fn("codex.refreshAll")(function* (
				ctx: ExtensionContext,
				requested: readonly CodexAccount[],
			) {
				for (const account of requested) {
					yield* Effect.tryPromise({
						try: () =>
							refreshAccountUsage({
								account,
								cachePath,
								auth: () =>
									runtime.runPromise(providerAuth(ctx, account.provider)),
							}),
						catch: accountFailure,
					});
				}
				return yield* Effect.tryPromise({
					try: () => readCache(cachePath),
					catch: accountFailure,
				});
			});

			const selectionLock = yield* Semaphore.make(1);
			const ensurePin = Effect.fn("codex.ensurePin")(function* (
				ctx: ExtensionContext,
			) {
				const model = ctx.model;
				if (
					(!accounts.length && !pin) ||
					!model ||
					!isCodexProvider(model.provider) ||
					switching
				)
					return;
				if (!pin) {
					let provider = previousProvider;
					if (!provider) {
						const cache = yield* refreshAll(ctx, accounts);
						const available = accounts.filter((account) => {
							const candidate = ctx.modelRegistry.find(
								account.provider,
								model.id,
							);
							return (
								candidate && ctx.modelRegistry.hasConfiguredAuth(candidate)
							);
						});
						provider = selectAccount(
							available,
							cache,
							yield* Clock.currentTimeMillis,
						)?.provider;
					}
					if (!provider)
						return yield* new CodexAccountError({
							message:
								"No Codex account has fresh weekly allowance. Run /codex-usage for details.",
						});
					const { accountId } = yield* providerAuth(ctx, provider);
					pin = {
						sessionId: ctx.sessionManager.getSessionId(),
						provider,
						accountId,
					};
					pi.appendEntry(PIN_ENTRY, pin);
				}
				if (model.provider === pin.provider) return;
				const target = ctx.modelRegistry.find(pin.provider, model.id);
				if (!target)
					return yield* new CodexAccountError({
						message: `Pinned Codex account ${pin.provider} is unavailable. Restore its configuration; this session will not switch accounts.`,
					});
				switching = true;
				yield* Effect.tryPromise({
					try: () => pi.setModel(target),
					catch: accountFailure,
				}).pipe(
					Effect.flatMap((changed) =>
						changed
							? Effect.void
							: Effect.fail(
									new CodexAccountError({
										message: `Pinned Codex account ${pin?.provider} is not authenticated.`,
									}),
								),
					),
					Effect.ensuring(
						Effect.sync(() => {
							switching = false;
						}),
					),
				);
			}, selectionLock.withPermit);

			for (const account of [originalAccount, ...accounts]) {
				pi.registerProvider(
					accountProvider(account, (apiKey) => {
						// Event hook exceptions are swallowed by Pi. Enforce the pin at
						// dispatch too, after the runtime resolves and refreshes OAuth.
						if (
							!accounts.length &&
							!pin &&
							account.provider === LOGICAL_PROVIDER
						)
							return;
						if (!pin || pin.provider !== account.provider)
							throw new Error(
								"Codex account selection did not complete; request blocked. Run /codex-usage.",
							);
						if (!apiKey || accountIdFromToken(apiKey) !== pin.accountId)
							throw new Error(
								`Pinned Codex account ${account.label} has changed identity. Reauthenticate the original account or start a new session.`,
							);
					}),
				);
			}

			pi.on("session_start", (event, ctx) =>
				runtime.runPromise(
					Effect.gen(function* () {
						const fresh = event.reason === "fork" || event.reason === "new";
						if (fresh && accounts.length)
							pi.appendEntry(FRESH_ENTRY, {
								sessionId: ctx.sessionManager.getSessionId(),
							});
						pin = fresh ? undefined : savedPin(ctx);
						// Native provider registration refreshes availability asynchronously.
						// Resume must wait before pi.setModel consults that snapshot.
						if (accounts.length || pin)
							yield* Effect.tryPromise({
								try: () => ctx.modelRegistry.refresh({ allowNetwork: false }),
								catch: accountFailure,
							});
						const startsUnselected = ctx.sessionManager
							.getEntries()
							.some(
								(entry) =>
									entry.type === "custom" &&
									entry.customType === FRESH_ENTRY &&
									isSessionMarker(entry.data) &&
									entry.data.sessionId === ctx.sessionManager.getSessionId(),
							);
						previousProvider =
							startsUnselected || pin ? undefined : legacyProvider(ctx);
						yield* ensurePin(ctx);
					}).pipe(
						Effect.catchIf(
							() => ctx.hasUI,
							(error) =>
								Effect.sync(() => ctx.ui.notify(error.message, "warning")),
						),
					),
				),
			);
			pi.on("model_select", (_event, ctx) =>
				switching ? undefined : runtime.runPromise(ensurePin(ctx)),
			);
			pi.on("input", (_event, ctx) =>
				runtime.runPromise(
					ensurePin(ctx).pipe(
						Effect.as({ action: "continue" } as const),
						Effect.catch((error) =>
							Effect.sync(() => {
								ctx.ui.notify(error.message, "error");
								return { action: "handled" } as const;
							}),
						),
					),
				),
			);
			pi.on("after_provider_response", (event, ctx) =>
				runtime.runPromise(
					Effect.gen(function* () {
						if (!pin || ctx.model?.provider !== pin.provider) return;
						const label =
							labelFromProvider(pin.provider) ?? originalAccount.label;
						const reading = parsePassiveHeaders(
							new Headers(event.headers),
							yield* Clock.currentTimeMillis,
						);
						if (reading) {
							const accountId = pin.accountId;
							yield* Effect.tryPromise(() =>
								updatePassiveUsage(cachePath, label, accountId, reading),
							);
						}
					}),
				),
			);
			pi.registerCommand("codex-usage", {
				description: "Show weekly allowance for all configured Codex accounts",
				handler: (_args, ctx) =>
					runtime.runPromise(
						Effect.gen(function* () {
							const requested =
								pin?.provider === LOGICAL_PROVIDER
									? [...accounts, originalAccount]
									: accounts;
							if (!requested.length) {
								ctx.ui.notify(
									`No Codex accounts configured. Add account labels to ${configPath}, then /reload and /login openai-codex@LABEL.`,
									"info",
								);
								return;
							}
							const cache = yield* refreshAll(ctx, requested);
							const label =
								pin &&
								(labelFromProvider(pin.provider) ?? originalAccount.label);
							ctx.ui.notify(
								formatUsage(
									requested,
									cache,
									label,
									yield* Clock.currentTimeMillis,
								),
								"info",
							);
						}),
					),
			});
		}),
	);
}
