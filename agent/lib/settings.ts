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
	const agentDir = getAgentDir();
	const projectTrusted = ctx.isProjectTrusted();
	const load = () =>
		SettingsManager.create(ctx.cwd, agentDir, { projectTrusted });
	const initial = load();
	let enabled = initial.getCompactionEnabled();
	let disposed = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const scheduleRetry = () => {
		// SDK lock reads busy-wait. Keep failures off render and rate-limit
		// retries, including watch notifications while contention persists.
		// Callback-owned resource, cancelled by the synchronous footer dispose.
		// @effect-diagnostics-next-line globalTimers:off
		retry = setTimeout(() => {
			retry = undefined;
			changed();
		}, 5000);
		retry.unref();
	};
	const paths = [join(agentDir, "settings.json")];
	if (projectTrusted)
		paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
	const changed = () => {
		if (disposed || retry !== undefined) return;
		const settings = load();
		if (settings.drainErrors().length > 0) {
			scheduleRetry();
			return;
		}
		const next = settings.getCompactionEnabled();
		if (next === enabled) return;
		enabled = next;
		onChange();
	};
	if (initial.drainErrors().length > 0) scheduleRetry();
	for (const path of paths)
		watchFile(path, { persistent: false, interval: 250 }, changed);
	return {
		enabled: () => enabled,
		dispose: () => {
			disposed = true;
			clearTimeout(retry);
			for (const path of paths) unwatchFile(path, changed);
		},
	};
}
