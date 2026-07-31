import { randomUUID } from "node:crypto";

const { writeFileSync } = process.getBuiltinModule("fs");
const { writeFile } = process.getBuiltinModule("fs/promises");

import { tmpdir } from "node:os";

const { join } = process.getBuiltinModule("path");

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Clock, Config, Effect } from "effect";
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

function delegateOutputPath(directory = tmpdir()) {
	return join(
		directory,
		`pi-delegate-${process.pid}-${Effect.runSync(Clock.currentTimeMillis)}-${randomUUID()}.txt`,
	);
}

export function saveDelegateOutput(text: string): string {
	const path = delegateOutputPath();
	writeFileSync(path, text, "utf8");
	return path;
}

export const formatDelegateOutput = Effect.fn("formatDelegateOutput")(
	function* (text: string, savedOutputFile?: string) {
		const truncation = truncateHead(text, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		if (!truncation.truncated) return { text };

		const directory = yield* Config.string("TMPDIR").pipe(
			Config.withDefault(tmpdir()),
		);
		const fullOutputFile = savedOutputFile ?? delegateOutputPath(directory);
		const archive = yield* (
			savedOutputFile
				? Effect.succeed(fullOutputFile)
				: Effect.tryPromise({
						try: () =>
							writeFile(fullOutputFile, text, "utf8").then(
								() => fullOutputFile,
							),
						catch: delegateError,
					})
		).pipe(
			Effect.map((fullOutputFile) => ({ fullOutputFile })),
			Effect.catch((error) => Effect.succeed({ error })),
		);
		if ("error" in archive) {
			return {
				text: `${text}\n\n[Delegated output exceeded the display limit but could not be saved, so the complete output is shown here: ${archive.error.message}]`,
			};
		}
		const summary = `${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})`;
		const notice = `[Delegated output truncated: ${summary}. ${savedOutputFile ? `Full output is available until the parent session ends at: ${archive.fullOutputFile}` : `Full output saved to: ${archive.fullOutputFile}`}]`;
		return {
			text: truncation.content ? `${truncation.content}\n\n${notice}` : notice,
			truncation,
			fullOutputFile: archive.fullOutputFile,
		};
	},
);
