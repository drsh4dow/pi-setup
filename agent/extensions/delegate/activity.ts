import { inspect } from "node:util";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { truncateUtf8Head } from "../../lib/text.ts";
import { type DelegateUsageStats, MAX_CHILD_OUTPUT_BYTES } from "./contract.ts";
import { errorMessage } from "./errors.ts";
import { extractAssistantText } from "./output.ts";

const MAX_ITEMS = 24;
const MAX_BYTES = 32 * 1024;
const MAX_ITEM_BYTES = 8 * 1024;
const MAX_ACTIVE_TOOLS = 64;
const MAX_VALUE_NODES = 64;
const MAX_VALUE_KEYS = 16;
const MAX_VALUE_DEPTH = 5;
const MAX_VALUE_STRING_CHARACTERS = 4_000;

function boundedString(text: string) {
  return text.length <= MAX_VALUE_STRING_CHARACTERS
    ? text
    : `${text.slice(0, MAX_VALUE_STRING_CHARACTERS)}…`;
}

function formatValue(value: unknown) {
  const state = { nodes: 0, seen: new WeakSet<object>() };
  const project = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return boundedString(item);
    if (
      item === null ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      typeof item === "undefined"
    ) {
      return item;
    }
    if (typeof item === "bigint") return "[bigint]";
    if (typeof item === "symbol") {
      return `Symbol(${boundedString(item.description ?? "")})`;
    }
    if (typeof item === "function") {
      return `[Function ${boundedString(item.name || "anonymous")}]`;
    }
    if (state.nodes++ >= MAX_VALUE_NODES) return "[node limit]";
    if (Buffer.isBuffer(item)) return `[Buffer: ${item.length} bytes]`;
    if (item instanceof Date) return boundedString(String(item));
    if (item instanceof Error) {
      return `${boundedString(item.name)}: ${boundedString(item.message)}`;
    }
    if (depth >= MAX_VALUE_DEPTH) return "[depth limit]";
    if (state.seen.has(item)) return "[circular]";
    state.seen.add(item);
    if (Array.isArray(item)) {
      const projected = item
        .slice(0, MAX_VALUE_KEYS)
        .map((entry) => project(entry, depth + 1));
      if (item.length > MAX_VALUE_KEYS) projected.push("[items omitted]");
      return projected;
    }

    const projected: Record<string, unknown> = Object.create(null);
    let keys = 0;
    try {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (keys++ >= MAX_VALUE_KEYS) {
          projected["..."] = "[properties omitted]";
          break;
        }
        try {
          projected[boundedString(key)] = project(
            (item as Record<string, unknown>)[key],
            depth + 1,
          );
        } catch (error) {
          projected[boundedString(key)] =
            `[unavailable: ${boundedString(errorMessage(error))}]`;
        }
      }
    } catch (error) {
      return `[uninspectable: ${boundedString(errorMessage(error))}]`;
    }
    return projected;
  };

  return inspect(project(value, 0), {
    depth: null,
    breakLength: 100,
    compact: false,
  });
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

export class ChildActivity {
  private readonly items: string[] = [];
  private readonly toolStarts = new Map<string, number>();
  private bytes = 0;
  private output = "";
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

  recent(): readonly string[] {
    return [...this.items];
  }

  state() {
    return {
      output: this.output,
      assistantStop: this.assistantStop,
      assistantError: this.assistantError,
      toolCalls: this.toolCalls,
      failedToolCalls: this.failedToolCalls,
      usage: { ...this.usage },
    };
  }

  beginRun() {
    this.output = "";
    this.assistantStop = undefined;
    this.assistantError = undefined;
  }

  capture(event: AgentSessionEvent) {
    if (event.type === "tool_execution_start") {
      this.toolCalls++;
      this.toolStarted(event.toolCallId, event.toolName, event.args);
    }
    if (event.type === "tool_execution_end") {
      if (event.isError) this.failedToolCalls++;
      this.toolFinished(
        event.toolCallId,
        event.toolName,
        event.result,
        event.isError,
      );
    }
    if (event.type !== "message_end") return;
    const text = messageText(event);
    if (event.message.role === "user" && text) {
      this.append(`role: user\nmessage:\n${text}`);
    }
    if (event.message.role !== "assistant") return;
    const assistantText = extractAssistantText(event.message);
    if (assistantText) {
      this.output = truncateUtf8Head(
        assistantText,
        MAX_CHILD_OUTPUT_BYTES,
        "\n[child output truncated]",
      );
      this.append(`role: assistant\nmessage:\n${assistantText}`);
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

  private toolStarted(
    id: string,
    name: string,
    input: unknown,
    now = Date.now(),
  ) {
    if (!this.toolStarts.has(id) && this.toolStarts.size === MAX_ACTIVE_TOOLS) {
      this.toolStarts.delete(this.toolStarts.keys().next().value as string);
    }
    this.toolStarts.set(id, now);
    this.append(
      `tool: ${name}\nid: ${id}\nstatus: running\nstarted: ${new Date(now).toISOString()}\ninput:\n${formatValue(input)}`,
    );
  }

  private toolFinished(
    id: string,
    name: string,
    output: unknown,
    failed: boolean,
    now = Date.now(),
  ) {
    const startedAt = this.toolStarts.get(id);
    this.toolStarts.delete(id);
    this.append(
      `tool: ${name}\nid: ${id}\nstatus: ${failed ? "error" : "done"}\nduration: ${startedAt === undefined ? "unknown" : `${Math.max(0, now - startedAt)}ms`}\n${failed ? "error" : "output"}:\n${formatValue(output)}`,
    );
  }

  private append(text: string) {
    const item = truncateUtf8Head(
      text,
      MAX_ITEM_BYTES,
      "\n[activity truncated]",
    );
    this.items.push(item);
    this.bytes += Buffer.byteLength(item);
    while (this.items.length > MAX_ITEMS || this.bytes > MAX_BYTES) {
      const removed = this.items.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(removed);
    }
  }
}
