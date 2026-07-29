import type { DelegateSnapshot } from "../contract.ts";

export function snapshot(
	overrides: Partial<DelegateSnapshot> = {},
): DelegateSnapshot {
	return {
		id: "delegate-1",
		status: "running",
		createdAt: 0,
		output: "",
		success: false,
		assignedTask: "inspect the parser seam",
		effort: "fast",
		requestedModel: "parent model",
		model: "anthropic/sonnet",
		thinking: "low",
		durationMs: 245_000,
		toolCalls: 12,
		failedToolCalls: 0,
		childUsage: {
			turns: 3,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
		},
		aborted: false,
		...overrides,
	};
}
