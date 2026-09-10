import { type Static, StringEnum, Type } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const RUN_TOOL_NAME = "delegate_run";
export const SESSION_TOOL_NAME = "delegate_session";
export const MAX_EXECUTION_MS = 60 * 60_000;
export const MAX_EXECUTION_TOKENS = 60_000_000;
export const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;
export const COLLAPSED_PREVIEW_LINES = 4;
export const COLLAPSED_PREVIEW_CHARS = 360;
export const CHILD_EXTENSION_PATHS_ENV = "PI_CHILD_EXTENSION_PATHS";

export const DelegateRunParams = Type.Object({
	task: Type.String({
		maxLength: 100_000,
		description:
			"Self-contained task for a fresh child that cannot see the parent conversation. Include the objective, relevant context/files, constraints, permissions, checks relevant to the assignment, and expected output.",
	}),
	cwd: Type.Optional(
		Type.String({
			maxLength: 4_096,
			description:
				"Existing directory the child runs in, absolute or relative to the parent's. Defaults to the parent's. Delegation only points the child at it; preparing and integrating it stays with the caller.",
		}),
	),
	model: Type.Optional(
		Type.String({
			maxLength: 256,
			description:
				'Exact "provider/model-id" for the child, overriding the configured delegate default. An unknown or unauthenticated model fails the run instead of substituting another.',
		}),
	),
	effort: Type.Optional(
		StringEnum(["fast", "thorough"], {
			description:
				"Configured model and reasoning profile for the child agent. Fast is the default for scouting, research, review, critique, and debugging. Use thorough only when explicitly requested, after a fast run demonstrates reasoning-limited uncertainty, or when an error would be costly and hard to detect or rerun.",
			default: "fast",
		}),
	),
	output_format: Type.Optional(
		Type.String({
			maxLength: 20_000,
			description:
				"Advisory guidance for presenting the result. Correct and complete information takes precedence over exact formatting.",
		}),
	),
});

const DelegateSessionFields = Type.Object({
	action: StringEnum(["list", "status", "send", "cancel"], {
		description:
			"list all children; inspect status; steer one running child; or cancel children",
	}),
	id: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 64,
			description: "Child id required by send",
		}),
	),
	// Session batches are deliberately unbounded: the product contract requires every parent-owned id to remain manageable without aggregate cutoffs.
	ids: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
			minItems: 1,
			description: "Child ids for cancel or status",
		}),
	),
	message: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 64_000,
			description:
				"Message required by send. It steers a running child, which sees only its own session; include any new context from the parent conversation that the child needs.",
		}),
	),
});

export const DelegateSessionParams = Type.Intersect(
	[
		DelegateSessionFields,
		Type.Union([
			Type.Object({ action: Type.Literal("list") }),
			Type.Object({
				action: Type.Literal("send"),
				...Type.Required(Type.Pick(DelegateSessionFields, ["id", "message"]))
					.properties,
			}),
			Type.Object({
				action: StringEnum(["status", "cancel"] as const),
				...Type.Required(Type.Pick(DelegateSessionFields, ["ids"])).properties,
			}),
		]),
	],
	{
		// Providers need root object fields; Pi validates the action union locally.
		type: "object",
		properties: DelegateSessionFields.properties,
		required: DelegateSessionFields.required,
	},
);

export type DelegateRunParams = Static<typeof DelegateRunParams>;
export type DelegateSessionParams = Static<typeof DelegateSessionParams>;
export type DelegateEffort = "fast" | "thorough";
export type DelegateThinking = AgentSession["thinkingLevel"];
export type DelegateStatus = "running" | "done" | "error" | "cancelled";

export interface DelegateUsageStats {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface DelegateDetails {
	success: boolean;
	assignedTask: string;
	effort: DelegateEffort;
	requestedModel: string;
	model?: string;
	thinking: DelegateThinking;
	fallbackReason?: string;
	durationMs: number;
	toolCalls: number;
	failedToolCalls: number;
	childUsage: DelegateUsageStats;
	childUsageUnavailable?: readonly (keyof Omit<DelegateUsageStats, "turns">)[];
	aborted: boolean;
	error?: string;
	progress?: string;
	idleMs?: number;
	checkpoint?: string;
	outputTruncated?: boolean;
	fullOutputFile?: string;
	/** Native child session identity and file for full conversation inspection. */
	childSessionId?: string;
	childSessionFile?: string;
}

export interface DelegateSnapshot extends DelegateDetails {
	id: string;
	status: DelegateStatus;
	createdAt: number;
	settledAt?: number;
	output: string;
}

export type DelegateSessionDetails =
	| DelegateSnapshot
	| { results: DelegateSnapshot[] }
	| undefined;
