// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The custom entry that puts a session in sh4dow mode. `/sh4dow` writes it before the first message. */
export const SH4DOW_MODE_ENTRY = "sh4dow-mode";

/** The sh4dow mode prompt, relative to the agent directory this extension sits in. */
export const SH4DOW_PROMPT = "system/generated/sh4dow.md";

const USAGE = "Usage: /sh4dow <ticket reference> [base branch] [target environment]";

type SessionEntries = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>;

/** Whether the session's entries put it in sh4dow mode. */
export function isSh4dowSession(entries: SessionEntries): boolean {
  return entries.some((entry) => entry.type === "custom" && entry.customType === SH4DOW_MODE_ENTRY);
}

type PromptRead = { kind: "read"; text: string } | { kind: "unreadable"; reason: string };

function readPrompt(path: string): PromptRead {
  try {
    return { kind: "read", text: readFileSync(path, "utf8") };
  } catch (error) {
    return { kind: "unreadable", reason: `cannot read ${path}: ${String(error)}` };
  }
}

function unreadablePrompt(reason: string): string {
  return `sh4dow mode ${reason}. Repeat that first sentence to the user, and make no tool calls until the user restores the file.`;
}

export function createSh4dowExtension(promptPath: string) {
  return (pi: ExtensionAPI): void => {
    pi.registerCommand("sh4dow", {
      description:
        "Coordinate a chunk in a new sh4dow-mode session: /sh4dow <ticket reference> [base branch] [target environment]",
      handler: (args, ctx) => {
        const chunk = args.trim();

        if (!chunk) {
          ctx.ui.notify(USAGE, "error");

          return Promise.resolve();
        }

        if (isSh4dowSession(ctx.sessionManager.getEntries())) {
          ctx.ui.notify(
            "/sh4dow refused: this session already runs in sh4dow mode. Type /sh4dow in a general session.",
            "error",
          );

          return Promise.resolve();
        }

        const prompt = readPrompt(promptPath);

        if (prompt.kind === "unreadable") {
          ctx.ui.notify(`/sh4dow refused: sh4dow mode ${prompt.reason}`, "error");

          return Promise.resolve();
        }

        return ctx
          .newSession({
            parentSession: ctx.sessionManager.getSessionFile(),
            setup: (sessionManager) => {
              sessionManager.appendCustomEntry(SH4DOW_MODE_ENTRY, { version: 1 });

              return Promise.resolve();
            },
            withSession: (next) => next.sendUserMessage(`The chunk: ${chunk}`),
          })
          .then(() => undefined);
      },
    });

    pi.on("before_agent_start", ({ systemPromptOptions: options }, ctx) => {
      if (!isSh4dowSession(ctx.sessionManager.getEntries())) return;

      const prompt = readPrompt(promptPath);
      options.customPrompt = prompt.kind === "read" ? prompt.text : unreadablePrompt(prompt.reason);
      options.skills = [];
    });
  };
}

export default createSh4dowExtension(
  fileURLToPath(new URL(`../../${SH4DOW_PROMPT}`, import.meta.url)),
);
