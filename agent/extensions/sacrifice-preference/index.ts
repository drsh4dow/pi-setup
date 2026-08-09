import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import {
	SACRIFICE_COMMAND_PREFIX,
	sacrificeKillNote,
} from "../../lib/sacrifice.ts";

// Replaces the built-in bash tool with an identically surfaced one whose commands
// carry the Sacrifice Preference tag, so earlyoom kills the command's processes
// instead of the session. The agent sees a difference only when a kill triggers.
export default function sacrificePreference(pi: ExtensionAPI) {
	if (process.platform !== "linux") return;
	const template = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...template,
		execute(toolCallId, params, signal, onUpdate, ctx) {
			const startedAt = Effect.runSync(Clock.currentTimeMillis);
			const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			});
			const userPrefix = settings.getShellCommandPrefix();
			const shellPath = settings.getShellPath();
			const tool = createBashToolDefinition(ctx.cwd, {
				commandPrefix: userPrefix
					? `${SACRIFICE_COMMAND_PREFIX}\n${userPrefix}`
					: SACRIFICE_COMMAND_PREFIX,
				...(shellPath ? { shellPath } : {}),
			});
			return tool
				.execute(toolCallId, params, signal, onUpdate, ctx)
				.catch((error) => {
					const match =
						error instanceof Error
							? error.message.match(/Command exited with code (\d+)$/)
							: null;
					const note = match
						? sacrificeKillNote(
								{ exitCode: Number(match[1]), signal: undefined },
								startedAt,
							)
						: undefined;
					if (note && error instanceof Error)
						throw new Error(`${error.message}\n${note}`);
					throw error;
				});
		},
	});
}
