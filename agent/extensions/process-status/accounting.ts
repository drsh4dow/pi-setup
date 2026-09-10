import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function sessionReportedUsage(entries: readonly SessionEntry[]) {
	const totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	const unavailable = new Set<keyof typeof totals>();
	let sawUsage = false;
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (
			entry.type === "message" &&
			(entry.message.role === "assistant" ||
				entry.message.role === "toolResult")
		) {
			usage = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			usage = entry.usage;
		}
		if (!usage) {
			if (
				usage !== undefined ||
				(entry.type === "message" && entry.message.role === "assistant")
			) {
				for (const field of Object.keys(totals) as (keyof typeof totals)[])
					unavailable.add(field);
			}
			continue;
		}
		sawUsage = true;
		const values = {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			cost: usage.cost?.total,
		};
		for (const field of Object.keys(totals) as (keyof typeof totals)[]) {
			const value = values[field];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0)
				totals[field] += value;
			else unavailable.add(field);
		}
	}
	if (!sawUsage)
		for (const field of Object.keys(totals) as (keyof typeof totals)[])
			unavailable.add(field);
	return {
		input: unavailable.has("input") ? null : totals.input,
		output: unavailable.has("output") ? null : totals.output,
		cacheRead: unavailable.has("cacheRead") ? null : totals.cacheRead,
		cacheWrite: unavailable.has("cacheWrite") ? null : totals.cacheWrite,
		totalTokens: unavailable.has("totalTokens") ? null : totals.totalTokens,
		cost: unavailable.has("cost") ? null : totals.cost,
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
