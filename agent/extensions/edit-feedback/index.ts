// Pi operations use native errno-bearing errors. Preserve its filesystem boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { access, readFile, writeFile } from "node:fs/promises";
import {
	createEditTool,
	createEditToolDefinition,
	type ExtensionAPI,
	truncateHead,
} from "@earendil-works/pi-coding-agent";

function contextFor(content: string, oldText: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const needle = oldText.replace(/\r\n/g, "\n");
	// Literal search supplies navigation hints only. Pi alone decides match validity.
	const candidateLines: number[] = [];
	if (needle) {
		let offset = normalized.indexOf(needle);
		while (offset >= 0 && candidateLines.length < 4) {
			candidateLines.push(normalized.slice(0, offset).split("\n").length - 1);
			offset = normalized.indexOf(needle, offset + 1);
		}
	}
	if (candidateLines.length === 0) {
		const anchor = needle
			.split("\n")
			.find((line) => line.trim())
			?.trim();
		if (anchor) {
			for (let i = 0; i < lines.length && candidateLines.length < 4; i++) {
				if (lines[i].includes(anchor)) candidateLines.push(i);
			}
		}
	}
	const locations = candidateLines.map((index) =>
		lines
			.slice(Math.max(0, index - 1), index + 2)
			.map(
				(line, offset) =>
					`${Math.max(0, index - 1) + offset + 1}: ${JSON.stringify(line.slice(0, 160))}${line.length > 160 ? " [line truncated]" : ""}`,
			)
			.join("\n"),
	);
	if (locations.length === 0)
		return "No nearby context found. Use read on the file or grep a shorter distinctive fragment, then copy oldText from the current file, preserving whitespace and newlines.";
	return `Candidate context from the original file (first 4 locations, 160 characters per line):\n${locations.join("\n...\n")}\nThese are navigation hints, not accepted matches. Use read around these lines, preserve whitespace and newlines, and include enough surrounding text to make oldText unique.`;
}

export function createDiagnosticEditTool(cwd: string) {
	return {
		...createEditToolDefinition(cwd),
		// Thin Promise adapter: Pi owns cancellation and the mutation queue.
		// @effect-diagnostics-next-line asyncFunction:off
		async execute(
			...args: Parameters<ReturnType<typeof createEditTool>["execute"]>
		) {
			let snapshot: Buffer | undefined;
			let writeStarted = false;
			const builtin = createEditTool(cwd, {
				operations: {
					access: (path) => access(path, constants.R_OK | constants.W_OK),
					readFile: (path) =>
						readFile(path).then((buffer) => {
							snapshot = buffer;
							return buffer;
						}),
					writeFile: (path, content) => {
						writeStarted = true;
						return writeFile(path, content, "utf8");
					},
				},
			});
			try {
				return await builtin.execute(...args);
			} catch (error) {
				if (!snapshot || writeStarted || args[2]?.aborted) throw error;
				// Probe the builtin against the captured buffer, never a second filesystem read.
				// A write attempt means matching succeeded. Stop before diff generation.
				const accepted = new Error("diagnostic probe accepted");
				const buffer = snapshot;
				const probe = createEditTool(cwd, {
					operations: {
						access: () => Promise.resolve(),
						readFile: () => Promise.resolve(buffer),
						writeFile: () => Promise.reject(accepted),
					},
				});
				let context =
					"No individual match rejection found in the first 32 edits. Check the original error for overlapping edits or identical replacements. Each entry targets the original file.";
				for (const [index, edit] of args[1].edits.slice(0, 32).entries()) {
					try {
						await probe.execute(
							args[0],
							{
								path: args[1].path,
								edits: [
									{ oldText: edit.oldText, newText: "\0pi-edit-diagnostic\0" },
								],
							},
							args[2],
						);
					} catch (probeError) {
						if (args[2]?.aborted) throw error;
						if (probeError === accepted) continue;
						context = `edits[${index}] rejected when checked alone.\n${contextFor(buffer.toString("utf8"), edit.oldText)}`;
						break;
					}
				}
				const message = truncateHead(
					error instanceof Error ? error.message : String(error),
					{ maxBytes: 1024, maxLines: 6 },
				);
				const diagnostic = truncateHead(
					`${message.content}${message.truncated ? " [error truncated]" : ""}\n\n${context}`,
					{ maxBytes: 7800, maxLines: 40 },
				);
				throw new Error(
					`${diagnostic.content}${diagnostic.truncated ? "\n[Diagnostics truncated. Use read for full context.]" : ""}`,
					{ cause: error },
				);
			}
		},
	};
}

export default function editFeedback(pi: ExtensionAPI) {
	pi.registerTool({
		...createDiagnosticEditTool(process.cwd()),
		execute(id, input, signal, onUpdate, ctx) {
			return createDiagnosticEditTool(ctx.cwd).execute(
				id,
				input,
				signal,
				onUpdate,
			);
		},
	});
}
