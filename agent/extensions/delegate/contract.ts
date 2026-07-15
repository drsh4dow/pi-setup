import { type Static, StringEnum, Type } from "@earendil-works/pi-ai";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "delegate";
export const TIMEOUT_MS = 15 * 60 * 1000;
export const COLLAPSED_PREVIEW_LINES = 4;
export const COLLAPSED_PREVIEW_CHARS = 360;
export const REQUESTED_MODEL = "parent model";
export const CHILD_EXTENSION_PATHS_ENV = "PI_CHILD_EXTENSION_PATHS";

export const DelegateParams = Type.Object({
  task: Type.String({
    description:
      "Self-contained task for the delegated child agent. Include objective, useful context/files, constraints, edit permission/read-only status, expected output, verification needs, and request for a concise handoff-ready report.",
  }),
  effort: Type.Optional(
    StringEnum(["fast", "thorough"], {
      description:
        "Reasoning depth for the child agent. Fast is the default for ordinary delegated work, including read-only scouting, docs/API lookup, review, noisy/root-cause investigation, and debugging. Use the thorough tier only when explicitly requested, when a fast result demonstrates reasoning-limited uncertainty, or when an error would be costly and difficult to detect, correct, or rerun. Natural-language requests for thorough work, task category, scope, and ambiguity alone do not select the explicit thorough effort tier.",
      default: "fast",
    }),
  ),
});

export type DelegateParams = Static<typeof DelegateParams>;
export type DelegateEffort = "fast" | "thorough";
export type DelegateThinking = "low" | "high";

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
  timedOut: boolean;
  aborted: boolean;
  error?: string;
  outputTruncated?: boolean;
  fullOutputFile?: string;
}

export interface DelegateOutput {
  text: string;
  truncation?: TruncationResult;
  fullOutputFile?: string;
}
