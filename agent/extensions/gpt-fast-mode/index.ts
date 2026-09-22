// Pure path operations do not need an Effect service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem, ManagedRuntime, Schema } from "effect";

export const SUPPORTED_MODELS = new Set([
	"openai/gpt-5.4",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.5",
	"openai/gpt-5.6",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"openai/gpt-6-sol",
	"openai/gpt-6-luna",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-6-astra",
	"openai-codex/gpt-6-sol",
	"openai-codex/gpt-6-luna",
]);

export const OPENAI_FAST_SERVICE_TIER = "fast";

export const CODEX_FAST_SERVICE_TIER = "priority";

export const KEYBINDING_FIELD = "pi-gpt-fast-mode";

export const DEFAULT_SHORTCUT = "ctrl+alt+m";

export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

const runtime = ManagedRuntime.make(BunFileSystem.layer);

const Keybindings = Schema.fromJsonString(
	Schema.Struct({
		[KEYBINDING_FIELD]: Schema.optional(Schema.Unknown),
	}),
);

const FastModeSettings = Schema.fromJsonString(
	Schema.Struct({
		enabled: Schema.optional(Schema.Boolean),
	}),
);

type PiModel = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;

export function fastServiceTier(
	model: PiModel | undefined,
): string | undefined {
	if (!model) return undefined;
	const { provider } = model;

	const logicalProvider = provider.startsWith("openai-codex@")
		? "openai-codex"
		: provider;

	if (!SUPPORTED_MODELS.has(`${logicalProvider}/${model.id}`)) return undefined;

	return logicalProvider === "openai-codex"
		? CODEX_FAST_SERVICE_TIER
		: OPENAI_FAST_SERVICE_TIER;
}

const isModelRequest = Schema.is(Schema.Struct({ model: Schema.String }));

export function withFastServiceTier<Payload>(
	model: PiModel | undefined,
	payload: Payload,
) {
	const serviceTier = fastServiceTier(model);

	return serviceTier && isModelRequest(payload) && payload.model === model?.id
		? { ...payload, service_tier: serviceTier }
		: payload;
}

export const loadShortcuts = Effect.fn("loadShortcuts")(
	function* (agentDir: string) {
		const fs = yield* FileSystem.FileSystem;

		const parsed = yield* Schema.decodeEffect(Keybindings)(
			yield* fs.readFileString(join(agentDir, "keybindings.json")),
		);

		const value = parsed[KEYBINDING_FIELD];

		if (value === false || value === null) return [];

		const shortcuts = (Array.isArray(value) ? value : [value]).flatMap(
			(item) => {
				if (!Schema.is(Schema.String)(item)) return [];
				const shortcut = item.trim();

				return shortcut && !RESERVED_SHORTCUTS.has(shortcut.toLowerCase())
					? [shortcut]
					: [];
			},
		);

		return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
	},
	Effect.orElseSucceed(() => [DEFAULT_SHORTCUT]),
);

const loadEnabled = Effect.fn("loadEnabled")(
	function* () {
		const fs = yield* FileSystem.FileSystem;

		const parsed = yield* Schema.decodeEffect(FastModeSettings)(
			yield* fs.readFileString(join(getAgentDir(), "gpt-fast-mode.json")),
		);

		return parsed.enabled === true;
	},
	Effect.orElseSucceed(() => false),
);

const saveEnabled = Effect.fn("saveEnabled")(function* (enabled: boolean) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.writeFileString(
		join(getAgentDir(), "gpt-fast-mode.json"),
		`${yield* Schema.encodeEffect(FastModeSettings)({ enabled })}\n`,
		{ mode: 0o600 },
	);
});

function announceState(ctx: ExtensionContext, enabled: boolean): void {
	if (!enabled) {
		ctx.ui.notify("GPT Fast mode disabled.", "info");

		return;
	}

	const model = ctx.model;
	const serviceTier = fastServiceTier(model);

	if (serviceTier) {
		ctx.ui.notify(
			`GPT Fast mode enabled (service_tier: ${serviceTier}).`,
			"info",
		);

		return;
	}

	ctx.ui.notify(
		`GPT Fast mode enabled, but ${model ? `${model.provider}/${model.id}` : "unknown model"} is not supported.`,
		"warning",
	);
}

const [initialEnabled, initialShortcuts] = await runtime.runPromise(
	Effect.all([loadEnabled(), loadShortcuts(getAgentDir())]),
);

export default function fastModeExtension(pi: ExtensionAPI): void {
	let enabled = initialEnabled;

	const toggle = (ctx: ExtensionContext) => {
		const nextEnabled = !enabled;

		return runtime.runPromise(
			saveEnabled(nextEnabled).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						enabled = nextEnabled;
						announceState(ctx, enabled);
					}),
				),
				Effect.catch(() =>
					Effect.sync(() =>
						ctx.ui.notify("Could not save GPT Fast mode setting.", "error"),
					),
				),
			),
		);
	};

	pi.registerCommand("fast", {
		description: "Toggle GPT Fast mode",
		handler: (_args, ctx) => toggle(ctx),
	});

	for (const shortcut of initialShortcuts)
		pi.registerShortcut(
			// SAFETY: The SDK's matchesKey parses arbitrary strings and ignores unknown keys; KeyId restricts autocomplete only.
			shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
			{ description: "Toggle GPT Fast mode", handler: (ctx) => toggle(ctx) },
		);
	pi.on("session_start", () =>
		runtime.runPromise(
			loadEnabled().pipe(
				Effect.tap((value) => Effect.sync(() => (enabled = value))),
				Effect.asVoid,
			),
		),
	);
	pi.on("before_provider_request", (event, ctx) =>
		enabled ? withFastServiceTier(ctx.model, event.payload) : undefined,
	);
}
