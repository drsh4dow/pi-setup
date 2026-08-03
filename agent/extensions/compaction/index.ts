import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import {
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	generateSummaryWithUsage,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

const MAX_BOUNDARY_TOKENS = 200_000;
export const DENSE_HANDOFF_INSTRUCTIONS = `Write a dense handoff that lets the same agent resume immediately.

Carry forward the current goal, user constraints and preferences, decisions and rationale, completed and in-progress work, blockers, failed approaches worth not repeating, verification evidence, exact files or symbols that matter, and any critical data not stored elsewhere. Always include a \`## Suggested Skills\` section for the continuing agent; write \`None\` when no skill applies. Reference durable artifacts such as plans, ADRs, issues, commits, diffs, and repository files instead of duplicating their contents. Omit greetings, narrative chronology, and low-value detail. Do not claim work or verification that the conversation does not evidence.`;

const CONTINUATION_INSTRUCTION =
	"Continue from the dense handoff. Choose and execute the best next action. If the task is complete, report the outcome without inventing more work.";

type FileDetails = { readFiles: string[]; modifiedFiles: string[] };

const comparePaths = (left: string, right: string) =>
	left < right ? -1 : left > right ? 1 : 0;

function isFileDetails(value: unknown): value is FileDetails {
	return (
		typeof value === "object" &&
		value !== null &&
		"readFiles" in value &&
		Array.isArray(value.readFiles) &&
		value.readFiles.every((path) => typeof path === "string") &&
		"modifiedFiles" in value &&
		Array.isArray(value.modifiedFiles) &&
		value.modifiedFiles.every((path) => typeof path === "string")
	);
}

function cumulativeFileDetails(
	fileOps: SessionBeforeCompactEvent["preparation"]["fileOps"],
	branchEntries: SessionBeforeCompactEvent["branchEntries"],
): FileDetails {
	const read = new Set(fileOps.read);
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (entry?.type !== "compaction") continue;
		if (isFileDetails(entry.details)) {
			for (const path of entry.details.readFiles) read.add(path);
			for (const path of entry.details.modifiedFiles) modified.add(path);
		}
		break;
	}
	return {
		readFiles: [...read]
			.filter((path) => !modified.has(path))
			.sort(comparePaths),
		modifiedFiles: [...modified].sort(comparePaths),
	};
}

export function compactionBoundary(contextWindow: number): number {
	return Math.min(Math.floor(contextWindow * 0.9), MAX_BOUNDARY_TOKENS);
}

export function createDenseHandoff(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	summarize: typeof generateSummaryWithUsage = generateSummaryWithUsage,
):
	| Promise<{ compaction: CompactionResult<FileDetails> } | undefined>
	| undefined {
	const model = ctx.model;
	if (!model) return;
	const focus = event.customInstructions?.trim();
	const instructions = focus
		? `${DENSE_HANDOFF_INSTRUCTIONS}\n\nUser-requested focus: ${focus}`
		: DENSE_HANDOFF_INSTRUCTIONS;
	const messages = [
		...event.preparation.messagesToSummarize,
		...event.preparation.turnPrefixMessages,
	];
	return ctx.modelRegistry
		.getApiKeyAndHeaders(model)
		.then((auth) => {
			if (!auth.ok) return;
			return summarize(
				messages,
				model,
				event.preparation.settings.reserveTokens,
				auth.apiKey,
				auth.headers,
				event.signal,
				instructions,
				event.preparation.previousSummary,
				ctx.thinkingLevel,
				undefined,
				auth.env,
			).then(({ text, usage }) => {
				const details = cumulativeFileDetails(
					event.preparation.fileOps,
					event.branchEntries,
				);
				const fileSections: string[] = [];
				if (details.readFiles.length > 0)
					fileSections.push(
						`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`,
					);
				if (details.modifiedFiles.length > 0)
					fileSections.push(
						`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`,
					);
				return {
					compaction: {
						summary:
							text +
							(fileSections.length > 0
								? `\n\n${fileSections.join("\n\n")}`
								: ""),
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						usage,
						details,
					},
				};
			});
		})
		.catch(() => undefined);
}

export default function compactionExtension(pi: ExtensionAPI): void {
	let generation = 0;
	let armed = true;
	let compacting = false;

	pi.on("session_start", () => {
		generation += 1;
		armed = true;
		compacting = false;
	});
	pi.on("session_shutdown", () => {
		generation += 1;
		compacting = false;
	});
	pi.on("session_before_compact", (event, ctx) =>
		event.reason === "threshold"
			? { cancel: true }
			: createDenseHandoff(event, ctx),
	);
	pi.on("turn_end", (event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;
		const boundary = compactionBoundary(usage.contextWindow);
		if (usage.tokens < boundary) {
			armed = true;
			return;
		}
		const overflowFromActiveModel =
			event.message.role === "assistant" &&
			ctx.model?.provider === event.message.provider &&
			ctx.model.id === event.message.model &&
			isContextOverflow(event.message, usage.contextWindow);
		if (!armed || compacting || overflowFromActiveModel) return;

		armed = false;
		compacting = true;
		const activeGeneration = generation;
		ctx.compact({
			onComplete: () => {
				if (generation !== activeGeneration) return;
				compacting = false;
				pi.sendMessage(
					{
						customType: "compaction-continuation",
						content: CONTINUATION_INSTRUCTION,
						display: false,
					},
					{ triggerTurn: true },
				);
			},
			onError: () => {
				if (generation !== activeGeneration) return;
				compacting = false;
				armed = true;
			},
		});
	});
}
