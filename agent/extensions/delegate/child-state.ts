import { Clock, Effect } from "effect";

const { unlinkSync } = process.getBuiltinModule("fs");

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { truncateUtf8Head, truncateUtf8Window } from "../../lib/text.ts";
import { type DelegateUsageStats, MAX_CHILD_OUTPUT_BYTES } from "./contract.ts";
import { extractAssistantText, saveDelegateOutput } from "./output.ts";

const MAX_TRAIL_MESSAGES = 6;
const MAX_TRAIL_TOOLS = 12;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_PROGRESS_BYTES = 240;
const MAX_TOOL_ARGS_BYTES = 120;
const MAX_TOOL_ERROR_BYTES = 200;

interface ToolEntry {
	seq: number;
	id: string;
	name: string;
	args: string;
	status: "running" | "done" | "error";
	error?: string;
}

interface MessageEntry {
	seq: number;
	text: string;
}

function messageText(event: AgentSessionEvent & { type: "message_end" }) {
	if (!("content" in event.message)) return "";
	const content = event.message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			part.type === "text" && part.text.trim() ? [part.text.trim()] : [],
		)
		.join("\n");
}

function progressLine(text: string) {
	return truncateUtf8Head(
		text.replace(/\s+/gu, " ").trim(),
		MAX_PROGRESS_BYTES,
		"…",
	);
}

function conversationMessage(role: string, text: string) {
	const bounded = truncateUtf8Window(
		text.trim(),
		MAX_MESSAGE_BYTES,
		MAX_MESSAGE_BYTES / 2,
		"\n\n[message truncated]\n\n",
	);
	return `${role}\n\n${bounded}`;
}

function compact(value: unknown, maxBytes: number) {
	if (value === undefined || value === null) return "";
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value) ?? "";
		} catch {
			return "";
		}
	}
	return truncateUtf8Head(text.replace(/\s+/gu, " ").trim(), maxBytes, "…");
}

// Tool results carry their message in content text parts; the envelope would eat the excerpt budget.
function resultText(result: unknown): unknown {
	const content = (result as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return result;
	const text = content
		.flatMap((part) =>
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
				? [(part as { text: string }).text]
				: [],
		)
		.join(" ");
	return text || result;
}

function toolLine(entry: ToolEntry) {
	const head = `Tool: ${entry.name}${entry.args ? ` ${entry.args}` : ""} · ${entry.status}`;
	return entry.error ? `${head}: ${entry.error}` : head;
}

export class ChildState {
	private readonly messages: MessageEntry[] = [];
	private readonly tools: ToolEntry[] = [];
	private seq = 0;
	private lastActivityAt = Effect.runSync(Clock.currentTimeMillis);
	private writing: string | undefined;
	private progress: string | undefined;
	private omitInitialUserMessage: boolean = true;
	private output = "";
	private outputTruncated = false;
	private fullOutputFile?: string;
	private assistantStop?: "error" | "aborted";
	private assistantError?: string;
	private toolCalls = 0;
	private failedToolCalls = 0;
	private readonly usage: DelegateUsageStats = {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};

	trail(): readonly string[] {
		const entries = [
			...this.messages,
			...this.tools.map((tool) => ({ seq: tool.seq, text: toolLine(tool) })),
		]
			.sort((left, right) => left.seq - right.seq)
			.map((entry) => entry.text);
		if (this.writing) entries.push(this.writing);
		return entries;
	}

	state() {
		return {
			progress: this.progress,
			lastActivityAt: this.lastActivityAt,
			output: this.output,
			outputTruncated: this.outputTruncated,
			fullOutputFile: this.fullOutputFile,
			assistantStop: this.assistantStop,
			assistantError: this.assistantError,
			toolCalls: this.toolCalls,
			failedToolCalls: this.failedToolCalls,
			usage: { ...this.usage },
		};
	}

	capture(event: AgentSessionEvent) {
		this.lastActivityAt = Effect.runSync(Clock.currentTimeMillis);
		if (event.type === "tool_execution_start") {
			this.toolCalls++;
			this.progress = `tool: ${progressLine(event.toolName)} · running`;
			this.tools.push({
				seq: ++this.seq,
				id: event.toolCallId,
				name: event.toolName,
				args: compact(event.args, MAX_TOOL_ARGS_BYTES),
				status: "running",
			});
			if (this.tools.length > MAX_TRAIL_TOOLS) this.tools.shift();
		}
		if (event.type === "tool_execution_end") {
			if (event.isError) this.failedToolCalls++;
			this.progress = `tool: ${progressLine(event.toolName)} · ${event.isError ? "error" : "done"}`;
			const entry = this.tools.find((tool) => tool.id === event.toolCallId);
			if (entry) {
				entry.status = event.isError ? "error" : "done";
				if (event.isError) {
					entry.error = compact(resultText(event.result), MAX_TOOL_ERROR_BYTES);
				}
			}
		}
		if (
			(event.type === "message_start" || event.type === "message_update") &&
			event.message.role === "assistant"
		) {
			this.omitInitialUserMessage = false;
			const text = extractAssistantText(event.message);
			this.writing = text
				? conversationMessage("Assistant (writing)", text)
				: undefined;
			if (text) this.progress = `writing: ${progressLine(text)}`;
		}
		if (event.type !== "message_end") return;

		const text = messageText(event);
		if (event.message.role === "user") {
			if (this.omitInitialUserMessage) {
				this.omitInitialUserMessage = false;
			} else if (text) {
				this.append(conversationMessage("User", text));
				this.progress = `steered: ${progressLine(text)}`;
			}
			return;
		}
		if (event.message.role !== "assistant") return;

		this.omitInitialUserMessage = false;
		this.writing = undefined;
		const assistantText = extractAssistantText(event.message);
		if (assistantText) {
			this.replaceOutput(assistantText);
			this.append(conversationMessage("Assistant", assistantText));
			this.progress = `said: ${progressLine(assistantText)}`;
		}
		if (
			event.message.stopReason === "error" ||
			event.message.stopReason === "aborted"
		) {
			this.assistantStop = event.message.stopReason;
			this.assistantError = event.message.errorMessage;
		}
		const usage = event.message.usage;
		this.usage.turns++;
		this.usage.input += usage?.input ?? 0;
		this.usage.output += usage?.output ?? 0;
		this.usage.cacheRead += usage?.cacheRead ?? 0;
		this.usage.cacheWrite += usage?.cacheWrite ?? 0;
		this.usage.totalTokens += usage?.totalTokens ?? 0;
		this.usage.cost += usage?.cost?.total ?? 0;
	}

	cleanup() {
		if (!this.fullOutputFile) return;
		const path = this.fullOutputFile;
		this.fullOutputFile = undefined;
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Effect.runSync(
					Effect.logError(
						`[delegate] could not remove saved output ${path}: ${error}`,
					),
				);
			}
		}
	}

	private replaceOutput(text: string) {
		this.cleanup();
		this.outputTruncated = false;
		if (Buffer.byteLength(text, "utf8") <= MAX_CHILD_OUTPUT_BYTES) {
			this.output = text;
			return;
		}
		try {
			this.fullOutputFile = saveDelegateOutput(text);
			this.outputTruncated = true;
			this.output = truncateUtf8Head(
				text,
				MAX_CHILD_OUTPUT_BYTES,
				`\n[child output truncated; full output saved to: ${this.fullOutputFile}]`,
			);
		} catch (error) {
			// Retaining the full response in memory is the lossless fallback when archival fails.
			this.output = text;
			Effect.runSync(
				Effect.logError(
					`[delegate] could not save oversized child output: ${error}`,
				),
			);
		}
	}

	private append(text: string) {
		this.messages.push({ seq: ++this.seq, text });
		if (this.messages.length > MAX_TRAIL_MESSAGES) this.messages.shift();
	}
}
