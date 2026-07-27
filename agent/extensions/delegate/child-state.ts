import { unlinkSync } from "node:fs";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { truncateUtf8Head, truncateUtf8Window } from "../../lib/text.ts";
import { type DelegateUsageStats, MAX_CHILD_OUTPUT_BYTES } from "./contract.ts";
import { extractAssistantText, saveDelegateOutput } from "./output.ts";

const MAX_CONVERSATION_MESSAGES = 6;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_PROGRESS_BYTES = 240;

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

function conversationMessage(role: string, text: string) {
  const bounded = truncateUtf8Window(
    text.trim(),
    MAX_MESSAGE_BYTES,
    MAX_MESSAGE_BYTES / 2,
    "\n\n[message truncated]\n\n",
  );
  return `${role}\n\n${bounded}`;
}

export class ChildState {
  private readonly messages: string[] = [];
  private writing: string | undefined;
  private progress: string | undefined;
  private omitInitialUserMessage = true;
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

  recentConversation(): readonly string[] {
    return this.writing
      ? [...this.messages.slice(-(MAX_CONVERSATION_MESSAGES - 1)), this.writing]
      : [...this.messages];
  }

  latestProgress(): string | undefined {
    return this.progress;
  }

  state() {
    return {
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
    if (event.type === "tool_execution_start") {
      this.toolCalls++;
      this.progress = `tool: ${truncateUtf8Head(event.toolName, MAX_PROGRESS_BYTES, "…")} · running`;
    }
    if (event.type === "tool_execution_end") {
      if (event.isError) this.failedToolCalls++;
      this.progress = `tool: ${truncateUtf8Head(event.toolName, MAX_PROGRESS_BYTES, "…")} · ${event.isError ? "error" : "done"}`;
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
      if (this.writing) this.progress = this.writing;
    }
    if (event.type !== "message_end") return;

    const text = messageText(event);
    if (event.message.role === "user") {
      if (this.omitInitialUserMessage) {
        this.omitInitialUserMessage = false;
      } else if (text) {
        const message = conversationMessage("User", text);
        this.append(message);
        this.progress = message;
      }
      return;
    }
    if (event.message.role !== "assistant") return;

    this.omitInitialUserMessage = false;
    this.writing = undefined;
    const assistantText = extractAssistantText(event.message);
    if (assistantText) {
      this.replaceOutput(assistantText);
      const message = conversationMessage("Assistant", assistantText);
      this.append(message);
      this.progress = message;
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
        console.error(
          `[delegate] could not remove saved output ${path}: ${error}`,
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
      console.error(
        `[delegate] could not save oversized child output: ${error}`,
      );
    }
  }

  private append(message: string) {
    this.messages.push(message);
    if (this.messages.length > MAX_CONVERSATION_MESSAGES) {
      this.messages.shift();
    }
  }
}
