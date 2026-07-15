import {
  COLLAPSED_PREVIEW_CHARS,
  COLLAPSED_PREVIEW_LINES,
  type DelegateDetails,
  type DelegateUsageStats,
} from "./contract.ts";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatCompactUsage(stats: DelegateUsageStats): string {
  const parts: string[] = [];
  if (stats.input > 0) parts.push(`↑${formatTokens(stats.input)}`);
  if (stats.output > 0) parts.push(`↓${formatTokens(stats.output)}`);
  if (stats.cost > 0) parts.push(`$${stats.cost.toFixed(4)}`);
  return parts.join(" ");
}

export function formatDetailedUsage(stats: DelegateUsageStats): string {
  const parts: string[] = [];
  if (stats.turns > 0) {
    parts.push(`${stats.turns} ${stats.turns === 1 ? "turn" : "turns"}`);
  }
  if (stats.input > 0) parts.push(`↑${formatTokens(stats.input)}`);
  if (stats.output > 0) parts.push(`↓${formatTokens(stats.output)}`);
  if (stats.cacheRead > 0) parts.push(`R${formatTokens(stats.cacheRead)}`);
  if (stats.cacheWrite > 0) parts.push(`W${formatTokens(stats.cacheWrite)}`);
  if (stats.totalTokens > 0) {
    parts.push(`total ${formatTokens(stats.totalTokens)}`);
  }
  if (stats.cost > 0) parts.push(`$${stats.cost.toFixed(4)}`);
  return parts.join(" ");
}

export function formatStatusParts(details: DelegateDetails): string {
  const name = details.model ?? "unknown model";
  const slash = name.lastIndexOf("/");
  const model = slash === -1 ? name : name.slice(slash + 1);
  let text = `${model}${details.fallbackReason ? " (fallback)" : ""} • ${formatDuration(details.durationMs)} • ${details.toolCalls} ${details.toolCalls === 1 ? "tool" : "tools"}`;
  if (details.failedToolCalls > 0) {
    text += ` • ${details.failedToolCalls} failed`;
  }
  return text;
}

export function formatCollapsedPreview(text: string): {
  text: string;
  truncated: boolean;
  hiddenLines: number;
} {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { text: "", truncated: false, hiddenLines: 0 };
  }

  const hiddenLines = Math.max(0, lines.length - COLLAPSED_PREVIEW_LINES);
  let truncated = hiddenLines > 0;
  let preview = lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n");
  if (preview.length > COLLAPSED_PREVIEW_CHARS) {
    preview = preview.slice(0, COLLAPSED_PREVIEW_CHARS - 1).trimEnd();
    truncated = true;
  }
  return { text: preview, truncated, hiddenLines };
}
