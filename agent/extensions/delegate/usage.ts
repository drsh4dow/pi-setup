import type { DelegateUsageStats } from "./contract.ts";

export type DelegateUsageField = keyof Omit<DelegateUsageStats, "turns">;

export interface DelegateUsageSample {
	usage: DelegateUsageStats;
	unavailable: readonly DelegateUsageField[];
}

export function aggregateDelegateUsage(
	samples: readonly DelegateUsageSample[],
) {
	const totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
	const unavailable = new Set<DelegateUsageField>();
	for (const sample of samples) {
		for (const field of Object.keys(totals) as DelegateUsageField[])
			totals[field] += sample.usage[field];
		for (const field of sample.unavailable) unavailable.add(field);
	}
	const reported = (field: DelegateUsageField) =>
		unavailable.has(field) ? null : totals[field];
	return {
		cost: reported("cost"),
		input: reported("input"),
		output: reported("output"),
		cacheRead: reported("cacheRead"),
		cacheWrite: reported("cacheWrite"),
		totalTokens: reported("totalTokens"),
	};
}
