import { type Static, StringEnum, Type } from "@earendil-works/pi-ai";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export const RUN_TOOL_NAME = "delegate_run";
export const SESSION_TOOL_NAME = "delegate_session";
export const WORKFLOW_TOOL_NAME = "delegate_workflow";
export const MAX_ACTIVE_CHILDREN = 4;
export const MAX_PENDING_CHILDREN = 32;
export const MAX_TRACKED_CHILDREN = 64;
export const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;
export const MAX_WORKFLOW_TASKS = 32;
export const MAX_WORKFLOW_STAGES = 8;
export const COLLAPSED_PREVIEW_LINES = 4;
export const COLLAPSED_PREVIEW_CHARS = 360;
export const CHILD_EXTENSION_PATHS_ENV = "PI_CHILD_EXTENSION_PATHS";

const StructuredOutputSchema = Type.Optional(
  Type.Unknown({
    description:
      "Optional bounded JSON Schema. The child must finish with structured_output matching it.",
  }),
);

export const DelegateRunParams = Type.Object({
  task: Type.String({
    maxLength: 100_000,
    description:
      "Self-contained task for a fresh child that cannot see the parent conversation. Include the objective, relevant context/files, constraints, permissions, verification, and expected output.",
  }),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return the child id immediately and automatically deliver its result later. Defaults to false, which waits for the final result.",
      default: false,
    }),
  ),
  effort: Type.Optional(
    StringEnum(["fast", "thorough"], {
      description:
        "Reasoning depth for the child agent. Fast is the default for scouting, research, review, critique, and debugging. Use thorough only when explicitly requested, after a fast run demonstrates reasoning-limited uncertainty, or when an error would be costly and hard to detect or rerun.",
      default: "fast",
    }),
  ),
  workspace: Type.Optional(
    StringEnum(["read", "write"], {
      description:
        "Workspace intent. Read jobs may overlap. Write jobs run exclusively because all children share one working tree. This schedules safely but does not sandbox filesystem writes.",
      default: "read",
    }),
  ),
  schema: StructuredOutputSchema,
});

export const DelegateSessionParams = Type.Object({
  action: StringEnum(["list", "status", "wait", "send", "cancel"], {
    description:
      "list all children; inspect status; wait for results; steer one running child; or cancel children",
  }),
  id: Type.Optional(
    Type.String({
      maxLength: 64,
      description: "Child id required by send",
    }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String({ maxLength: 64 }), {
      maxItems: 16,
      description: "Child ids for wait, cancel, or status",
    }),
  ),
  message: Type.Optional(
    Type.String({
      maxLength: 64_000,
      description:
        "Message required by send. It steers a running child, which sees only its own session; include any new context from the parent conversation that the child needs.",
    }),
  ),
});

const WorkflowTask = Type.Object({
  id: Type.String({
    maxLength: 64,
    description: "Unique task id used by later-stage inputs",
  }),
  task: Type.String({
    maxLength: 100_000,
    description:
      "Self-contained task for a fresh child that cannot see the parent conversation. Include the objective, relevant context/files, constraints, permissions, verification, and expected output. Earlier workflow inputs provide only their declared outputs, not undeclared parent context.",
  }),
  effort: Type.Optional(StringEnum(["fast", "thorough"])),
  workspace: Type.Optional(StringEnum(["read", "write"])),
  inputs: Type.Optional(
    Type.Array(Type.String({ maxLength: 64 }), {
      maxItems: 16,
      description:
        "Ids of earlier-stage tasks whose outputs should be appended to this task",
    }),
  ),
  schema: StructuredOutputSchema,
  allow_failure: Type.Optional(
    Type.Boolean({
      description:
        "Continue later stages when this task fails. Defaults to false.",
    }),
  ),
});

const WorkflowStage = Type.Object({
  name: Type.Optional(
    Type.String({ maxLength: 160, description: "Stage label" }),
  ),
  tasks: Type.Array(WorkflowTask, {
    minItems: 1,
    maxItems: 16,
    description: "Tasks in a stage run concurrently within the global cap",
  }),
});

export const DelegateWorkflowParams = Type.Object({
  stages: Type.Array(WorkflowStage, {
    minItems: 1,
    maxItems: MAX_WORKFLOW_STAGES,
    description:
      "Stages run sequentially; tasks within each stage run concurrently. A stage containing a write task must contain only that task.",
  }),
});

export type DelegateRunParams = Static<typeof DelegateRunParams>;
export type DelegateSessionParams = Static<typeof DelegateSessionParams>;
export type DelegateWorkflowParams = Static<typeof DelegateWorkflowParams>;
export type DelegateEffort = "fast" | "thorough";
export type DelegateThinking = "low" | "high";
export type DelegateWorkspace = "read" | "write";
export type DelegateStatus =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "cancelled";

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
  aborted: boolean;
  error?: string;
  structured?: unknown;
  outputTruncated?: boolean;
  fullOutputFile?: string;
}

export interface DelegateSnapshot extends DelegateDetails {
  id: string;
  status: DelegateStatus;
  workspace: DelegateWorkspace;
  createdAt: number;
  settledAt?: number;
  output: string;
}

export interface DelegateOutput {
  text: string;
  truncation?: TruncationResult;
  fullOutputFile?: string;
}
