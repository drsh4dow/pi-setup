import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
	Config,
	Effect,
	FileSystem,
	Layer,
	ManagedRuntime,
	Path,
	Schema,
} from "effect";

export const SUPPORTED_MODELS = new Set([
	"openai/gpt-5.4",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.5",
	"openai/gpt-5.6",
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"openai-codex/gpt-5.4",
	"openai-codex/gpt-5.5",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-6-astra",
]);
export const OPENAI_FAST_SERVICE_TIER = "fast";
export const CODEX_FAST_SERVICE_TIER = "priority";
export const KEYBINDING_FIELD = "pi-gpt-fast-mode";
export const DEFAULT_SHORTCUT = "ctrl+alt+m";
export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

const runtime = ManagedRuntime.make(
	Layer.mergeAll(BunFileSystem.layer, BunPath.layer),
);
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
	if (!SUPPORTED_MODELS.has(`${provider}/${model.id}`)) return undefined;
	return provider === "openai-codex"
		? CODEX_FAST_SERVICE_TIER
		: OPENAI_FAST_SERVICE_TIER;
}
export function withFastServiceTier(
	model: PiModel | undefined,
	payload: unknown,
): unknown {
	const serviceTier = fastServiceTier(model);
	return serviceTier &&
		payload &&
		typeof payload === "object" &&
		"model" in payload &&
		payload.model === model?.id
		? { ...payload, service_tier: serviceTier }
		: payload;
}

function expandHome(input: string, home: string, path: Path.Path): string {
	if (input === "~") return home;
	return input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
}

export const resolvePiFilePath = Effect.fn("resolvePiFilePath")(function* (
	fileName: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const env = yield* Config.all({
		HOME: Config.string("HOME").pipe(Config.withDefault("")),
		PI_CODING_AGENT_DIR: Config.string("PI_CODING_AGENT_DIR").pipe(
			Config.withDefault(""),
		),
		XDG_CONFIG_HOME: Config.string("XDG_CONFIG_HOME").pipe(
			Config.withDefault(""),
		),
	});
	const piDir = env.PI_CODING_AGENT_DIR.trim();
	if (piDir)
		return path.join(path.resolve(expandHome(piDir, env.HOME, path)), fileName);
	const xdgConfigHome = env.XDG_CONFIG_HOME.trim()
		? path.resolve(expandHome(env.XDG_CONFIG_HOME, env.HOME, path))
		: path.join(env.HOME, ".config");
	for (const candidate of [
		path.join(xdgConfigHome, "pi", "agent", fileName),
		path.join(xdgConfigHome, "pi", fileName),
	]) {
		if (yield* fs.exists(candidate)) return candidate;
	}
	return path.join(env.HOME, ".pi", "agent", fileName);
});
export const resolveFastModeSettingsPath = () =>
	resolvePiFilePath("gpt-fast-mode.json");

export function normalizeShortcutSetting(value: unknown): string[] {
	if (value === false || value === null) return [];
	const shortcuts = (Array.isArray(value) ? value : [value])
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean)
		.filter((shortcut) => !RESERVED_SHORTCUTS.has(shortcut.toLowerCase()));
	return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
}

export const loadShortcuts = Effect.fn("loadShortcuts")(
	function* () {
		const fs = yield* FileSystem.FileSystem;
		const parsed = yield* Schema.decodeEffect(Keybindings)(
			yield* fs.readFileString(yield* resolvePiFilePath("keybindings.json")),
		);
		return normalizeShortcutSetting(parsed[KEYBINDING_FIELD]);
	},
	Effect.orElseSucceed(() => [DEFAULT_SHORTCUT]),
);

export const loadEnabled = Effect.fn("loadEnabled")(
	function* () {
		const fs = yield* FileSystem.FileSystem;
		const parsed = yield* Schema.decodeEffect(FastModeSettings)(
			yield* fs.readFileString(yield* resolveFastModeSettingsPath()),
		);
		return parsed.enabled === true;
	},
	Effect.orElseSucceed(() => false),
);

export const saveEnabled = Effect.fn("saveEnabled")(function* (
	enabled: boolean,
) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.writeFileString(
		yield* resolveFastModeSettingsPath(),
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
	Effect.all([loadEnabled(), loadShortcuts()]),
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
