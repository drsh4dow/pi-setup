import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import { earlyoomKillSince, SACRIFICE_TAG } from "../../lib/sacrifice.ts";

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
			const tool = createBashToolDefinition(ctx.cwd, {
				commandPrefix: SACRIFICE_TAG,
			});
			return tool
				.execute(toolCallId, params, signal, onUpdate, ctx)
				.catch((error) => {
					if (
						error instanceof Error &&
						/Command exited with code (137|143)$/.test(error.message) &&
						earlyoomKillSince(startedAt)
					) {
						throw new Error(
							`${error.message}\nA process in this command was likely killed by earlyoom under system memory pressure; pi-spawned work dies before the session.`,
						);
					}
					throw error;
				});
		},
	});
}
