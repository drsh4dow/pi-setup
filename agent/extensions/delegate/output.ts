import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { DelegateOutput } from "./contract.ts";
import { delegateError } from "./errors.ts";

export function extractAssistantText(message: {
  role?: unknown;
  content?: unknown;
}): string {
  if (message.role !== "assistant") return "";
  const content = message.content;

  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const maybeText = part as { type?: unknown; text?: unknown };
      if (maybeText.type !== "text" || typeof maybeText.text !== "string") {
        return [];
      }
      const text = maybeText.text.trim();
      return text ? [text] : [];
    })
    .join("\n");
}

export function formatDelegateOutputEffect(
  text: string,
): Effect.Effect<DelegateOutput> {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncation.truncated) return Effect.succeed({ text });

  const withNotice = (notice: string): string =>
    truncation.content ? `${truncation.content}\n\n${notice}` : notice;
  const summary = `${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})`;

  return Effect.gen(function* () {
    const fullOutputFile = yield* Effect.try({
      try: () =>
        join(
          tmpdir(),
          `pi-delegate-${process.pid}-${Date.now()}-${randomUUID()}.txt`,
        ),
      catch: delegateError,
    });
    yield* Effect.tryPromise({
      try: () => writeFile(fullOutputFile, text, "utf8"),
      catch: delegateError,
    });
    return {
      text: withNotice(
        `[Delegated output truncated: ${summary}. Full output saved to: ${fullOutputFile}]`,
      ),
      truncation,
      fullOutputFile,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        text: withNotice(
          `[Delegated output truncated: ${summary}. Full output could not be saved: ${error.message}]`,
        ),
        truncation,
      }),
    ),
  );
}

export async function formatDelegateOutput(
  text: string,
): Promise<DelegateOutput> {
  return Effect.runPromise(formatDelegateOutputEffect(text));
}
