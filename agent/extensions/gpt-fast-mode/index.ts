import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { FileSystem, Layer, ManagedRuntime, Path, Schema } from "effect";

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

export async function resolvePiFilePath(
	fileName: string,
	options: PiFileOptions = {},
): Promise<string> {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME ?? "";
	const exists =
		options.exists ??
		((candidate: string) =>
			runtime.runPromise(
				FileSystem.FileSystem.use((fs) => fs.exists(candidate)),
			));
	const piDir = env.PI_CODING_AGENT_DIR?.trim();
	if (piDir)
		return pathService.join(
			pathService.resolve(expandHome(piDir, home)),
			fileName,
		);
	const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
		? pathService.resolve(expandHome(env.XDG_CONFIG_HOME, home))
		: pathService.join(home, ".config");
	for (const candidate of [
		pathService.join(xdgConfigHome, "pi", "agent", fileName),
		pathService.join(xdgConfigHome, "pi", fileName),
	])
		if (await exists(candidate)) return candidate;
	return pathService.join(home, ".pi", "agent", fileName);
}
export const resolveKeybindingsPath = (options: PiFileOptions = {}) =>
	resolvePiFilePath("keybindings.json", options);
export const resolveFastModeSettingsPath = (options: PiFileOptions = {}) =>
	resolvePiFilePath("gpt-fast-mode.json", options);

function normalizeShortcutList(values: unknown[]): string[] {
	return values
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean)
		.filter((shortcut) => !RESERVED_SHORTCUTS.has(shortcut.toLowerCase()));
}
export function normalizeShortcutSetting(value: unknown): string[] {
	if (value === false || value === null) return [];
	const shortcuts = normalizeShortcutList(
		Array.isArray(value) ? value : [value],
	);
	return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
}

async function readText(path: string, options: PiFileOptions): Promise<string> {
	if (options.readFile) return options.readFile(path, "utf8");
	return runtime.runPromise(
		FileSystem.FileSystem.use((fs) => fs.readFileString(path)),
	);
}
export async function loadShortcuts(
	options: PiFileOptions = {},
): Promise<string[]> {
	try {
		const parsed = Schema.decodeUnknownSync(Keybindings)(
			await readText(await resolveKeybindingsPath(options), options),
		);
		return normalizeShortcutSetting(parsed[KEYBINDING_FIELD]);
	} catch {
		return [DEFAULT_SHORTCUT];
	}
}
export async function loadEnabled(
	options: PiFileOptions = {},
): Promise<boolean> {
	try {
		const parsed = Schema.decodeUnknownSync(FastModeSettings)(
			await readText(await resolveFastModeSettingsPath(options), options),
		);
		return parsed.enabled === true;
	} catch {
		return false;
	}
}
export async function saveEnabled(
	enabled: boolean,
	options: PiFileOptions = {},
): Promise<void> {
	const path = await resolveFastModeSettingsPath(options);
	const data = `${JSON.stringify({ enabled }, null, 2)}\n`;
	if (options.writeFile)
		return options.writeFile(path, data, { encoding: "utf8", mode: 0o600 });
	return runtime.runPromise(
		FileSystem.FileSystem.use((fs) =>
			fs.writeFileString(path, data, { mode: 0o600 }),
		),
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
	const toggle = async (ctx: unknown) => {
		const nextEnabled = !enabled;
		try {
			await saveEnabled(nextEnabled);
			enabled = nextEnabled;
			announceState(ctx, enabled);
		} catch {
			notify(ctx, "Could not save GPT Fast mode setting.", "error");
		}
	};
	pi.registerCommand("fast", {
		description: "Toggle GPT Fast mode",
		handler: async (_args, ctx) => toggle(ctx),
	});
	for (const shortcut of initialShortcuts)
		pi.registerShortcut(
			shortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
			{ description: "Toggle GPT Fast mode", handler: (ctx) => toggle(ctx) },
		);
	pi.on("session_start", async () => {
		enabled = await loadEnabled();
	});
	pi.on("before_provider_request", (event, ctx) =>
		enabled && shouldApplyFastMode(ctx.model, event.payload)
			? withFastServiceTier(ctx.model, event.payload)
			: undefined,
	);
}
