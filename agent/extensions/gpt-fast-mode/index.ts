import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
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
]);
export const OPENAI_FAST_SERVICE_TIER = "fast";
export const CODEX_FAST_SERVICE_TIER = "priority";
export const KEYBINDING_FIELD = "pi-gpt-fast-mode";
export const DEFAULT_SHORTCUT = "ctrl+alt+m";
export const RESERVED_SHORTCUTS = new Set(["ctrl+m", "enter", "return"]);

const runtime = ManagedRuntime.make(
	Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCrypto.layer),
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

type PiModel = { provider?: string; id?: string };
type ProviderPayload = Record<string, unknown>;
type PiFileOptions = {
	env?: Record<string, string | undefined>;
	home?: string;
	exists?: (path: string) => boolean | Promise<boolean>;
	readFile?: (path: string, encoding: "utf8") => string | Promise<string>;
	writeFile?: (
		path: string,
		data: string,
		options: { encoding: "utf8"; mode: number },
	) => void | Promise<void>;
};

export function modelKey(model: PiModel): string {
	return `${model.provider}/${model.id}`;
}
export function isSupportedModel(model: PiModel | undefined): boolean {
	return Boolean(
		model?.provider && model.id && SUPPORTED_MODELS.has(modelKey(model)),
	);
}
export function fastServiceTier(
	model: PiModel | undefined,
): string | undefined {
	if (!isSupportedModel(model)) return undefined;
	return model?.provider === "openai-codex"
		? CODEX_FAST_SERVICE_TIER
		: OPENAI_FAST_SERVICE_TIER;
}
export function shouldApplyFastMode(
	model: PiModel | undefined,
	payload: unknown,
): boolean {
	return Boolean(
		payload &&
			typeof payload === "object" &&
			fastServiceTier(model) &&
			(payload as ProviderPayload).model === model?.id,
	);
}
export function withFastServiceTier(
	model: PiModel | undefined,
	payload: unknown,
): unknown {
	const serviceTier = fastServiceTier(model);
	return serviceTier && payload && typeof payload === "object"
		? { ...(payload as ProviderPayload), service_tier: serviceTier }
		: payload;
}

const pathService = runtime.runSync(Path.Path);
function expandHome(input: string, home: string): string {
	if (input === "~") return home;
	return input.startsWith("~/")
		? pathService.join(home, input.slice(2))
		: input;
}

const resolvePiFilePathEffect = Effect.fn("resolvePiFilePath")(function* (
	fileName: string,
	options: PiFileOptions = {},
) {
	const configured =
		options.env ??
		(yield* Config.all({
			HOME: Config.string("HOME").pipe(Config.withDefault("")),
			PI_CODING_AGENT_DIR: Config.string("PI_CODING_AGENT_DIR").pipe(
				Config.withDefault(""),
			),
			XDG_CONFIG_HOME: Config.string("XDG_CONFIG_HOME").pipe(
				Config.withDefault(""),
			),
		}));
	const home = options.home ?? configured.HOME ?? "";
	const piDir = configured.PI_CODING_AGENT_DIR?.trim();
	if (piDir)
		return pathService.join(
			pathService.resolve(expandHome(piDir, home)),
			fileName,
		);
	const xdgConfigHome = configured.XDG_CONFIG_HOME?.trim()
		? pathService.resolve(expandHome(configured.XDG_CONFIG_HOME, home))
		: pathService.join(home, ".config");
	for (const candidate of [
		pathService.join(xdgConfigHome, "pi", "agent", fileName),
		pathService.join(xdgConfigHome, "pi", fileName),
	]) {
		const exists = options.exists
			? yield* Effect.promise(() =>
					Promise.resolve(options.exists?.(candidate)),
				)
			: yield* FileSystem.FileSystem.use((fs) => fs.exists(candidate)).pipe(
					Effect.provide(BunFileSystem.layer),
				);
		if (exists) return candidate;
	}
	return pathService.join(home, ".pi", "agent", fileName);
});
export function resolvePiFilePath(
	fileName: string,
	options: PiFileOptions = {},
): Promise<string> {
	return Effect.runPromise(resolvePiFilePathEffect(fileName, options));
}
export const resolveFastModeSettingsPath = (options: PiFileOptions = {}) =>
	resolvePiFilePath("gpt-fast-mode.json", options);

export function normalizeShortcutSetting(value: unknown): string[] {
	if (value === false || value === null) return [];
	const shortcuts = (Array.isArray(value) ? value : [value])
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean)
		.filter((shortcut) => !RESERVED_SHORTCUTS.has(shortcut.toLowerCase()));
	return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
}

const readText = Effect.fn("readText")(function* (
	path: string,
	options: PiFileOptions,
) {
	return options.readFile
		? yield* Effect.promise(() =>
				Promise.resolve(options.readFile?.(path, "utf8")),
			)
		: yield* FileSystem.FileSystem.use((fs) => fs.readFileString(path)).pipe(
				Effect.provide(BunFileSystem.layer),
			);
});
export function loadShortcuts(options: PiFileOptions = {}): Promise<string[]> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const path = yield* resolvePiFilePathEffect("keybindings.json", options);
			const parsed = yield* Schema.decodeUnknownEffect(Keybindings)(
				yield* readText(path, options),
			);
			return normalizeShortcutSetting(parsed[KEYBINDING_FIELD]);
		}).pipe(Effect.orElseSucceed(() => [DEFAULT_SHORTCUT])),
	);
}
export function loadEnabled(options: PiFileOptions = {}): Promise<boolean> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const path = yield* resolvePiFilePathEffect(
				"gpt-fast-mode.json",
				options,
			);
			const parsed = yield* Schema.decodeUnknownEffect(FastModeSettings)(
				yield* readText(path, options),
			);
			return parsed.enabled === true;
		}).pipe(Effect.orElseSucceed(() => false)),
	);
}
export function saveEnabled(
	enabled: boolean,
	options: PiFileOptions = {},
): Promise<void> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const path = yield* resolvePiFilePathEffect(
				"gpt-fast-mode.json",
				options,
			);
			const data = `${yield* Schema.encodeEffect(FastModeSettings)({ enabled })}\n`;
			if (options.writeFile)
				return yield* Effect.promise(() =>
					Promise.resolve(
						options.writeFile?.(path, data, { encoding: "utf8", mode: 0o600 }),
					),
				);
			yield* FileSystem.FileSystem.use((fs) =>
				fs.writeFileString(path, data, { mode: 0o600 }),
			).pipe(Effect.provide(BunFileSystem.layer));
		}),
	);
}

function notify(
	ctx: unknown,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	(
		ctx as
			| { ui?: { notify?: (message: string, level?: string) => void } }
			| undefined
	)?.ui?.notify?.(message, level);
}
function announceState(ctx: unknown, enabled: boolean): void {
	if (!enabled) {
		notify(ctx, "GPT Fast mode disabled.");
		return;
	}
	const model = (ctx as { model?: PiModel } | undefined)?.model;
	const serviceTier = fastServiceTier(model);
	if (serviceTier) {
		notify(ctx, `GPT Fast mode enabled (service_tier: ${serviceTier}).`);
		return;
	}
	notify(
		ctx,
		`GPT Fast mode enabled, but ${model?.provider && model.id ? modelKey(model) : "unknown model"} is not supported.`,
		"warning",
	);
}

const initialEnabled = await loadEnabled();
const initialShortcuts = await loadShortcuts();
export default function fastModeExtension(pi: ExtensionAPI): void {
	let enabled = initialEnabled;
	const toggle = (ctx: unknown) =>
		Effect.runPromise(
			Effect.tryPromise(() => saveEnabled(!enabled)).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						enabled = !enabled;
						announceState(ctx, enabled);
					}),
				),
				Effect.catch(() =>
					Effect.sync(() =>
						notify(ctx, "Could not save GPT Fast mode setting.", "error"),
					),
				),
			),
		);
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
		Effect.runPromise(
			Effect.promise(() => loadEnabled()).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						enabled = value;
					}),
				),
				Effect.asVoid,
			),
		),
	);
	pi.on("before_provider_request", (event, ctx) =>
		enabled && shouldApplyFastMode(ctx.model, event.payload)
			? withFastServiceTier(ctx.model, event.payload)
			: undefined,
	);
}
