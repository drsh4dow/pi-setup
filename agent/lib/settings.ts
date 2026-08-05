import {
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export function isAutoCompactionEnabled(ctx: ExtensionContext): boolean {
	return SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	}).getCompactionEnabled();
}
