// Stat polling also observes files whose parent directory does not exist yet.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { unwatchFile, watchFile } from "node:fs";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, Path } from "effect";

const { join } = Effect.runSync(Path.Path.pipe(Effect.provide(BunPath.layer)));

import {
	CONFIG_DIR_NAME,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function isAutoCompactionEnabled(ctx: ExtensionContext): boolean {
	return SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	}).getCompactionEnabled();
}

/** Observe persisted settings, including creation/replacement of either file. */
export function observeAutoCompaction(
	ctx: ExtensionContext,
	onChange: () => void,
): { enabled: () => boolean; dispose: () => void } {
	let enabled = isAutoCompactionEnabled(ctx);
	const paths = [join(getAgentDir(), "settings.json")];
	if (ctx.isProjectTrusted())
		paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
	const changed = () => {
		const next = isAutoCompactionEnabled(ctx);
		if (next === enabled) return;
		enabled = next;
		onChange();
	};
	for (const path of paths)
		watchFile(path, { persistent: false, interval: 250 }, changed);
	return {
		enabled: () => enabled,
		dispose: () => {
			for (const path of paths) unwatchFile(path, changed);
		},
	};
}
