import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import {
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	generateSummaryWithUsage,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { isAutoCompactionEnabled } from "../../lib/settings.ts";

export const DENSE_HANDOFF_INSTRUCTIONS = `Write a dense handoff of only the compacted prefix. A newer raw conversation tail will remain after this summary, so describe prefix state as provisional rather than current. Newer retained messages and canonical state always override the summary.

Carry forward the goal, user constraints and preferences, decisions and rationale, completed and in-progress work, blockers, failed approaches worth not repeating, verification evidence, exact files or symbols that matter, and critical data not stored elsewhere. Reference durable artifacts such as plans, ADRs, issues, commits, diffs, and repository files instead of duplicating their contents. Omit greetings, narrative chronology, and low-value detail. Do not claim work or verification that the conversation does not evidence. Use stable account, profile, and lab identifiers, never credential bodies, personal data, cookies, tokens, or secret-file paths.

Always include this exact structure, using \`Unknown — recover from retained tail and canonical state\` wherever the prefix lacks evidence:

## Resume Contract
- **Active controller skill:** Path or name to reload, or None.
- **Active branches (reload):** Only branch guides still active; do not list historical or superseded reads.
- **Canonical authority:** Bounded recovery command, artifact, and stable identifiers.
- **Mutation lease:** Lease/event ID, causal thread, experiment, and bounds, or None.
- **Economics interval:** Target/rank/envelope/stop-loss; last closed interval endpoint; open work tag and start snapshot; latest usage snapshot.
- **Invocation-level completion gate:** Terminal criteria or exact canonical pointer; checkpoints and local findings are not completion.
- **Latest next-action:** Action, may_stop value, freshness, and command that reruns the liveness gate.`;

const CONTINUATION_INSTRUCTION =
	"Reconcile this prefix summary with the newer retained tail first. Then reload the active controller and only active branches from the Resume Contract; recover bounded canonical state; reconcile the mutation lease before mutation; rerun the liveness gate; then act from the latest next-action. Report completion only when the recovered invocation-level completion gate permits it.";

const NATIVE_FALLBACK_CONTINUATION =
	"The custom Resume Contract was unavailable after native compaction. Before mutation, reconcile the newer retained tail, reload the active controller, recover bounded canonical state, reconcile the mutation lease before mutation, and rerun the liveness gate. Then act from the latest canonical next-action. Report completion only when the recovered invocation-level completion gate permits it.";

const UNKNOWN_RESUME_CONTRACT = `## Resume Contract
- **Active controller skill:** Unknown — recover from retained tail and canonical state.
- **Active branches (reload):** Unknown — recover from retained tail and canonical state.
- **Canonical authority:** Unknown — recover from retained tail and canonical state.
- **Mutation lease:** Unknown — recover from retained tail and canonical state.
- **Economics interval:** Unknown — recover last closed interval endpoint, open work tag and start snapshot, and latest usage snapshot from canonical state.
- **Invocation-level completion gate:** Unknown — recover from retained tail and canonical state.
- **Latest next-action:** Unknown — recover from retained tail and canonical state, then rerun the liveness gate.`;

const RESUME_CONTRACT_FIELDS = [
	"Active controller skill",
	"Active branches (reload)",
	"Canonical authority",
	"Mutation lease",
	"Economics interval",
	"Invocation-level completion gate",
	"Latest next-action",
] as const;

const SENSITIVE_LINE_PATTERNS = [
	/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|passwd|passphrase|private[_ -]?key|secret)\b\s*[:=]/i,
	/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:/i,
	/\bbearer\s+[a-z0-9._~+/-]+=*/i,
	/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
	/(?:\+\d{1,3}[ .-])?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/,
	/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b/i,
	/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
] as const;

const HANDOFF_CONTRACT_VERSION = 1;
const SUMMARY_SCOPE = "prefix-before-retained-tail" as const;
const MAX_BOUNDARY_TOKENS = 250_000;

type FileDetails = { readFiles: string[]; modifiedFiles: string[] };
type HandoffDetails = FileDetails & {
	handoffContractVersion: typeof HANDOFF_CONTRACT_VERSION;
	summaryScope: typeof SUMMARY_SCOPE;
	redactionCount: number;
	summarizerProvider: string;
	summarizerModel: string;
	summarizedMessageCount: number;
	reason: SessionBeforeCompactEvent["reason"];
};

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

function isSensitivePath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	return (
		/(?:^|\/)\.(?:ssh|gnupg|aws|azure|kube)(?:\/|$)/.test(normalized) ||
		/(?:^|\/)(?:keyrings?|credentials?|secrets?)(?:\/|$)/.test(normalized) ||
		/(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.(?:json|ya?ml|toml|db)|credentials(?:\.(?:json|ya?ml|toml|ini|db))?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx))$/.test(
			normalized,
		)
	);
}

function collectFileDetails(
	messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"],
	branchEntries: SessionBeforeCompactEvent["branchEntries"],
): FileDetails & { redactedPathCount: number } {
	const read = new Set<string>();
	const modified = new Set<string>();
	const redacted = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const path =
				typeof block.arguments?.path === "string"
					? block.arguments.path
					: undefined;
			if (!path) continue;
			if (isSensitivePath(path)) {
				redacted.add(path);
				continue;
			}
			if (block.name === "read") read.add(path);
			if (block.name === "edit" || block.name === "write") modified.add(path);
		}
	}
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index];
		if (entry?.type !== "compaction") continue;
		if (isFileDetails(entry.details)) {
			for (const path of entry.details.modifiedFiles) {
				if (isSensitivePath(path)) redacted.add(path);
				else modified.add(path);
			}
		}
		break;
	}
	return {
		readFiles: [...read]
			.filter((path) => !modified.has(path))
			.sort(comparePaths),
		modifiedFiles: [...modified].sort(comparePaths),
		redactedPathCount: redacted.size,
	};
}

function redactSummary(text: string): { text: string; count: number } {
	let count = 0;
	let insidePrivateKey = false;
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		const startsPrivateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line);
		const endsPrivateKey = /-----END [A-Z ]*PRIVATE KEY-----/.test(line);
		const hasSensitivePath = line
			.split(/\s+/)
			.map((part) =>
				part.replace(/^[`'"(<[]+/, "").replace(/[`'">)\],.;:]+$/, ""),
			)
			.some(isSensitivePath);
		if (startsPrivateKey) insidePrivateKey = true;
		if (
			insidePrivateKey ||
			hasSensitivePath ||
			SENSITIVE_LINE_PATTERNS.some((pattern) => pattern.test(line))
		) {
			count += 1;
			lines.push(
				"[REDACTED: recover sensitive value from canonical local state]",
			);
		} else lines.push(line);
		if (endsPrivateKey) insidePrivateKey = false;
	}
	return { text: lines.join("\n"), count };
}

function ensureResumeContract(text: string): string {
	if (
		/^## Resume Contract\s*$/m.test(text) &&
		RESUME_CONTRACT_FIELDS.every((field) => text.includes(`**${field}:**`))
	)
		return text;
	const heading = /^## Resume Contract\s*$/m.exec(text);
	if (!heading) return `${text.trim()}\n\n${UNKNOWN_RESUME_CONTRACT}`;
	const afterHeading = heading.index + heading[0].length;
	const nextHeading = /^## /m.exec(text.slice(afterHeading));
	const end = nextHeading ? afterHeading + nextHeading.index : text.length;
	const withoutContract =
		`${text.slice(0, heading.index)}${text.slice(end)}`.trim();
	return withoutContract
		? `${withoutContract}\n\n${UNKNOWN_RESUME_CONTRACT}`
		: UNKNOWN_RESUME_CONTRACT;
}

function hasHandoffContract(details: unknown): details is HandoffDetails {
	return (
		isFileDetails(details) &&
		"handoffContractVersion" in details &&
		details.handoffContractVersion === HANDOFF_CONTRACT_VERSION &&
		"summaryScope" in details &&
		details.summaryScope === SUMMARY_SCOPE
	);
}

export function compactionBoundary(contextWindow: number): number {
	return Math.min(Math.floor(contextWindow * 0.85), MAX_BOUNDARY_TOKENS);
}

export function createDenseHandoff(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	summarize: typeof generateSummaryWithUsage = generateSummaryWithUsage,
):
	| Promise<{ compaction: CompactionResult<HandoffDetails> } | undefined>
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
				const files = collectFileDetails(messages, event.branchEntries);
				const redacted = redactSummary(text);
				const details: HandoffDetails = {
					readFiles: files.readFiles,
					modifiedFiles: files.modifiedFiles,
					handoffContractVersion: HANDOFF_CONTRACT_VERSION,
					summaryScope: SUMMARY_SCOPE,
					redactionCount: redacted.count + files.redactedPathCount,
					summarizerProvider: model.provider,
					summarizerModel: model.id,
					summarizedMessageCount: messages.length,
					reason: event.reason,
				};
				const fileSections: string[] = [];
				if (details.readFiles.length > 0)
					fileSections.push(
						`<read-files>\n${details.readFiles.join("\n")}\n</read-files>`,
					);
				if (details.modifiedFiles.length > 0)
					fileSections.push(
						`<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>`,
					);
				const scope = `## Summary Scope\nThis summary covers only the prefix before retained tail entry \`${event.preparation.firstKeptEntryId}\`. Newer retained messages and canonical state override it. Reconcile both before any mutation.`;
				return {
					compaction: {
						summary: [
							ensureResumeContract(redacted.text),
							scope,
							...fileSections,
						].join("\n\n"),
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

export default function compactionExtension(
	pi: ExtensionAPI,
	autoCompactionEnabled: (
		ctx: ExtensionContext,
	) => boolean = isAutoCompactionEnabled,
): void {
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
		if (!autoCompactionEnabled(ctx)) return;
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
			onComplete: (result) => {
				if (generation !== activeGeneration) return;
				compacting = false;
				pi.sendMessage(
					{
						customType: "compaction-continuation",
						content: hasHandoffContract(result.details)
							? CONTINUATION_INSTRUCTION
							: NATIVE_FALLBACK_CONTINUATION,
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
