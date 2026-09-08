import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type ProcessStatusUsage, sessionReportedUsage } from "./status.ts";

export function sessionAccounting(
	entries: readonly SessionEntry[],
	delegates: ProcessStatusUsage,
) {
	const parent = sessionReportedUsage(entries);
	const child = {
		input: delegates.input ?? null,
		output: delegates.output ?? null,
		cacheRead: delegates.cacheRead ?? null,
		cacheWrite: delegates.cacheWrite ?? null,
		totalTokens: delegates.totalTokens ?? null,
		cost: delegates.cost,
	};
	const add = (a: number | null, b: number | null) =>
		a === null || b === null ? null : a + b;
	return {
		parent,
		delegates: child,
		total: {
			input: add(parent.input, child.input),
			output: add(parent.output, child.output),
			cacheRead: add(parent.cacheRead, child.cacheRead),
			cacheWrite: add(parent.cacheWrite, child.cacheWrite),
			totalTokens: add(parent.totalTokens, child.totalTokens),
			cost: add(parent.cost, child.cost),
		},
	};
}

export function sessionDuration(
	startedAt: string | undefined,
	entries: readonly SessionEntry[],
) {
	const latest = entries.findLast((entry) => entry.type === "message");
	if (!latest) return "0s";
	const elapsed = Date.parse(latest.timestamp) - Date.parse(startedAt ?? "");
	if (!Number.isFinite(elapsed)) return "?";
	const seconds = Math.max(0, Math.floor(elapsed / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return [
		hours ? `${hours}h` : "",
		minutes ? `${minutes}m` : "",
		`${seconds % 60}s`,
	]
		.filter(Boolean)
		.join(" ");
}

export function accountingText(cost: number | null, subscription: boolean) {
	return `USD ${cost === null ? "?" : cost.toFixed(3)}${subscription ? " (sub)" : ""}`;
}
