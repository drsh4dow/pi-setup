// Pure path operations do not need an Effect service.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import {
  type ExtensionAPI,
  getAgentDir,
  type ModelChangeEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, FileSystem } from "effect";

// The model in effect at the branch's first prompt. Before that prompt is
// recorded, this is the current model.
function sessionModel(branch: SessionEntry[]): ModelChangeEntry | undefined {
  let model: ModelChangeEntry | undefined;

  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") break;

    if (entry.type === "model_change") model = entry;
  }

  return model;
}

export default function modelSystemPromptExtension(
  pi: ExtensionAPI,
  agentDir = getAgentDir(),
): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      // Read at load time, like Pi reads SYSTEM.md, so edits apply on /reload.
      const fs = yield* FileSystem.FileSystem;
      const defaultPrompt = yield* fs.readFileString(join(agentDir, "SYSTEM.md"));
      const gptPrompt = yield* fs.readFileString(join(agentDir, "GPT_SYSTEM.md"));

      pi.on("before_agent_start", ({ systemPromptOptions: options }, ctx) => {
        // A trusted project SYSTEM.md or --system-prompt applies to every model.
        if (options.customPrompt !== defaultPrompt) return;

        if (sessionModel(ctx.sessionManager.getBranch())?.modelId.startsWith("gpt-"))
          options.customPrompt = gptPrompt;
      });
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
}
