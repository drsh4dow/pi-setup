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
