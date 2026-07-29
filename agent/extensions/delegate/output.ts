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
import { Clock, Effect } from "effect";
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

function delegateOutputPath() {
	return join(
		tmpdir(),
		`pi-delegate-${process.pid}-${Effect.runSync(Clock.currentTimeMillis)}-${randomUUID()}.txt`,
	);
}

export function saveDelegateOutput(text: string): string {
	const path = delegateOutputPath();
	writeFileSync(path, text, "utf8");
	return path;
}

export function formatDelegateOutputEffect(
	text: string,
	savedOutputFile?: string,
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
		const fullOutputFile =
			savedOutputFile ??
			(yield* Effect.try({
				try: delegateOutputPath,
				catch: delegateError,
			}));
		if (!savedOutputFile) {
			yield* Effect.tryPromise({
				try: () => writeFile(fullOutputFile, text, "utf8"),
				catch: delegateError,
			});
		}
		return {
			text: withNotice(
				`[Delegated output truncated: ${summary}. ${savedOutputFile ? `Full output is available until the parent session ends at: ${fullOutputFile}` : `Full output saved to: ${fullOutputFile}`}]`,
			),
			truncation,
			fullOutputFile,
		};
	}).pipe(
		Effect.catch((error) =>
			Effect.succeed({
				text: `${text}\n\n[Delegated output exceeded the display limit but could not be saved, so the complete output is shown here: ${error.message}]`,
			}),
		),
	);
}

export async function formatDelegateOutput(
	text: string,
	savedOutputFile?: string,
): Promise<DelegateOutput> {
	return Effect.runPromise(formatDelegateOutputEffect(text, savedOutputFile));
}
