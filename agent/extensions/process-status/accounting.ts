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

export function accountingText(
	total: ReturnType<typeof sessionAccounting>["total"],
	entries: readonly SessionEntry[],
	subscription: boolean,
) {
	const tokens = (value: number | null) =>
		value === null ? "?" : value.toLocaleString("en-US");
	const parts = [
		`↑${tokens(total.input)}`,
		`↓${tokens(total.output)}`,
		`R${tokens(total.cacheRead)}`,
		`W${tokens(total.cacheWrite)}`,
		`Σ${tokens(total.totalTokens)}`,
	];
	// Match Pi's latest-parent-response cache hit semantics, never the delegates' ratio.
	const parent = sessionReportedUsage(entries);
	const latest = entries.findLast(
		(entry) => entry.type === "message" && entry.message.role === "assistant",
	);
	if (latest?.type === "message" && latest.message.role === "assistant") {
		const usage = latest.message.usage;
		if (
			usage &&
			[usage.input, usage.cacheRead, usage.cacheWrite].every(
				(value) => Number.isFinite(value) && value >= 0,
			)
		) {
			const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
			if (
				prompt > 0 &&
				((total.cacheRead ?? parent.cacheRead ?? 0) > 0 ||
					(total.cacheWrite ?? parent.cacheWrite ?? 0) > 0)
			)
				parts.push(`CH${((usage.cacheRead / prompt) * 100).toFixed(1)}%`);
		}
	}
	parts.push(
		total.cost === null ? "USD unavailable" : `$${total.cost.toFixed(3)}`,
	);
	if (subscription) parts.push("(sub)");
	if (Object.values(total).includes(null)) parts.push("?=unavailable");
	return parts.join(" ");
}
