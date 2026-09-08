import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { sessionReportedUsage } from "../process-status/status.ts";
import { ChildState } from "./child-state.ts";

const { readFileSync, realpathSync } = process.getBuiltinModule("fs");
const { dirname, join, resolve } = process.getBuiltinModule("path");

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DelegateSnapshot } from "./contract.ts";

export const DELEGATE_STATE_ENTRY = "delegate-state-v1";

export type DelegateStateRecord =
	| { kind: "accepted"; ownerSessionId: string; snapshot: DelegateSnapshot }
	| { kind: "started"; ownerSessionId: string; snapshot: DelegateSnapshot }
	| { kind: "settled"; ownerSessionId: string; snapshot: DelegateSnapshot };

const nonnegative = Schema.Number.check(
	Schema.isFinite(),
	Schema.isGreaterThanOrEqualTo(0),
);
const optionalText = Schema.optional(Schema.String);
const fields = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"totalTokens",
	"cost",
] as const;
const usageFields = Schema.Literals(fields);
const snapshotSchema = Schema.Struct({
	id: Schema.String,
	assignedTask: Schema.String,
	status: Schema.Literals(["running", "done", "error", "cancelled"]),
	createdAt: nonnegative,
	settledAt: Schema.optional(nonnegative),
	output: Schema.String,
	success: Schema.Boolean,
	effort: Schema.Literals(["fast", "thorough"]),
	requestedModel: Schema.String,
	model: optionalText,
	thinking: Schema.Literals([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	]),
	fallbackReason: optionalText,
	durationMs: nonnegative,
	toolCalls: nonnegative,
	failedToolCalls: nonnegative,
	childUsage: Schema.Struct({
		turns: nonnegative,
		input: nonnegative,
		output: nonnegative,
		cacheRead: nonnegative,
		cacheWrite: nonnegative,
		totalTokens: nonnegative,
		cost: nonnegative,
	}),
	childUsageUnavailable: Schema.optional(Schema.Array(usageFields)),
	aborted: Schema.Boolean,
	error: optionalText,
	progress: optionalText,
	idleMs: Schema.optional(nonnegative),
	checkpoint: optionalText,
	outputTruncated: Schema.optional(Schema.Boolean),
	fullOutputFile: optionalText,
	childSessionId: optionalText,
	childSessionFile: optionalText,
});
const recordSchema = Schema.Struct({
	kind: Schema.Literals(["accepted", "started", "settled"]),
	ownerSessionId: Schema.String,
	snapshot: snapshotSchema,
});
const isRecord = Schema.is(recordSchema);
const isOwner = Schema.is(Schema.Struct({ ownerSessionId: Schema.String }));
const isOwnedRecord = Schema.is(
	Schema.Struct({
		ownerSessionId: Schema.String,
		snapshot: Schema.Struct({ id: Schema.String }),
	}),
);
function parseRecord(value: unknown): DelegateStateRecord | undefined {
	return isRecord(value) &&
		(value.kind === "settled"
			? value.snapshot.status !== "running"
			: value.snapshot.status === "running")
		? value
		: undefined;
}

export function delegateStateRecord(
	ownerSessionId: string,
	kind: DelegateStateRecord["kind"],
	snapshot: DelegateSnapshot,
): DelegateStateRecord {
	return { kind, ownerSessionId, snapshot };
}

export function recoverDelegateStates(
	sessionManager: Pick<
		SessionManager,
		"getEntries" | "getSessionId" | "getSessionFile" | "getSessionDir"
	>,
): DelegateSnapshot[] {
	const ownerSessionId = sessionManager.getSessionId();
	const latest = new Map<string, DelegateStateRecord>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== DELEGATE_STATE_ENTRY)
			continue;
		const record = parseRecord(entry.data);
		if (record?.ownerSessionId === ownerSessionId)
			latest.set(record.snapshot.id, record);
		else if (
			isOwner(entry.data) &&
			entry.data.ownerSessionId === ownerSessionId
		) {
			const id = isOwnedRecord(entry.data)
				? entry.data.snapshot.id
				: `invalid-${entry.id}`;
			latest.set(id, {
				kind: "settled",
				ownerSessionId,
				snapshot: {
					id,
					status: "error",
					success: false,
					assignedTask: "Unavailable: invalid delegate metadata",
					effort: "fast",
					requestedModel: "unavailable",
					thinking: "off",
					createdAt: 0,
					durationMs: 0,
					output: "",
					toolCalls: 0,
					failedToolCalls: 0,
					aborted: false,
					error: "Invalid saved delegate metadata; usage unavailable.",
					childUsage: {
						turns: 0,
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: 0,
					},
					childUsageUnavailable: fields,
				},
			});
		}
	}
	return [...latest.values()].map((record) => {
		const snapshot = recoverChild(record.snapshot, sessionManager);
		if (record.kind === "settled") return snapshot;
		return {
			...snapshot,
			status: "error",
			success: false,
			settledAt: record.snapshot.settledAt ?? record.snapshot.createdAt,
			error: "Delegate execution ended before a settlement record was written.",
			progress: undefined,
		};
	});
}

function recoverChild(
	snapshot: DelegateSnapshot,
	parent: Pick<
		SessionManager,
		"getSessionFile" | "getSessionId" | "getSessionDir"
	>,
): DelegateSnapshot {
	if (!snapshot.childSessionFile) return snapshot;
	try {
		const parentFile = parent.getSessionFile();
		if (!parentFile) throw new Error("Parent has no session file");
		const directory = realpathSync(
			join(parent.getSessionDir(), "delegates", parent.getSessionId()),
		);
		const file = realpathSync(snapshot.childSessionFile);
		if (dirname(file) !== directory)
			throw new Error("Child file is outside its owner's directory");
		// The SDK parser is read-only. SessionManager.open can rewrite legacy or empty files.
		const content = readFileSync(file, "utf8");
		const entries = parseSessionEntries(content);
		if (
			entries.length !==
			content.split("\n").filter((line) => line.trim()).length
		)
			throw new Error("Invalid native session record");
		const header = entries[0];
		if (
			header?.type !== "session" ||
			header.id !== snapshot.childSessionId ||
			!header.parentSession ||
			resolve(header.parentSession) !== resolve(parentFile)
		)
			throw new Error("Child session identity does not match ownership");
		const messages = entries.filter((entry) => entry.type !== "session");
		const state = new ChildState(false);
		for (const entry of messages) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "assistant") {
				for (const content of message.content)
					if (content.type === "toolCall")
						state.capture({
							type: "tool_execution_start",
							toolCallId: content.id,
							toolName: content.name,
							args: content.arguments,
						});
			} else if (message.role === "toolResult") {
				state.capture({
					type: "tool_execution_end",
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					result: message,
					isError: message.isError,
				});
			}
			state.capture({ type: "message_end", message });
		}
		const history = state.state();
		const reported = sessionReportedUsage(messages);
		return {
			...snapshot,
			output: history.output,
			outputTruncated: history.outputTruncated,
			fullOutputFile: undefined,
			checkpoint: state.trail().join("\n\n"),
			toolCalls: history.toolCalls,
			failedToolCalls: history.failedToolCalls,
			childUsage: {
				turns: history.usage.turns,
				input: reported.input ?? 0,
				output: reported.output ?? 0,
				cacheRead: reported.cacheRead ?? 0,
				cacheWrite: reported.cacheWrite ?? 0,
				totalTokens: reported.totalTokens ?? 0,
				cost: reported.cost ?? 0,
			},
			childUsageUnavailable: fields.filter((field) => reported[field] === null),
		};
	} catch {
		return { ...snapshot, childUsageUnavailable: fields };
	}
}
