import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type DelegateSnapshot,
  type DelegateWorkflowParams,
  MAX_WORKFLOW_TASKS,
} from "./contract.ts";
import type { DelegateManager } from "./manager.ts";
import { formatSnapshotOutput } from "./output.ts";

const MAX_HANDOFF_BYTES = 32 * 1024;

export interface WorkflowTaskResult {
  id: string;
  stage: string;
  allowFailure: boolean;
  snapshot: DelegateSnapshot;
}

export interface WorkflowResult {
  success: boolean;
  error?: string;
  activeStage?: string;
  activeTasks: WorkflowTaskResult[];
  startedAt: number;
  finishedAt: number;
  tasks: WorkflowTaskResult[];
}

function taskOutput(result: WorkflowTaskResult): string {
  return `## ${result.id}\n${formatSnapshotOutput(result.snapshot) || "(no output)"}`;
}

function validateWorkflow(params: DelegateWorkflowParams) {
  const ids = new Set<string>();
  let count = 0;
  for (const [stageIndex, stage] of params.stages.entries()) {
    count += stage.tasks.length;
    if (count > MAX_WORKFLOW_TASKS) {
      throw new Error(`Workflow exceeds the ${MAX_WORKFLOW_TASKS}-task limit.`);
    }
    if (
      stage.tasks.some((task) => task.workspace === "write") &&
      stage.tasks.length !== 1
    ) {
      throw new Error(
        `Stage ${stageIndex + 1} contains a write task and must contain no other tasks.`,
      );
    }
    for (const task of stage.tasks) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.id)) {
        throw new Error(
          `Invalid workflow task id "${task.id}"; use 1-64 letters, digits, underscores, or hyphens.`,
        );
      }
      if (ids.has(task.id)) {
        throw new Error(`Duplicate workflow task id "${task.id}".`);
      }
      for (const input of task.inputs ?? []) {
        if (!ids.has(input)) {
          throw new Error(
            `Task "${task.id}" input "${input}" must reference an earlier-stage task.`,
          );
        }
      }
      ids.add(task.id);
    }
  }
}

export async function runWorkflow(
  manager: DelegateManager,
  params: DelegateWorkflowParams,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onProgress?: (result: WorkflowResult) => void,
): Promise<WorkflowResult> {
  validateWorkflow(params);
  const startedAt = Date.now();
  const results: WorkflowTaskResult[] = [];
  const byId = new Map<string, WorkflowTaskResult>();
  const startedIds: string[] = [];
  let activeStage: string | undefined;
  let activeTasks: WorkflowTaskResult[] = [];

  const current = (success: boolean, error?: string): WorkflowResult => ({
    success,
    error,
    activeStage,
    activeTasks: activeTasks.map((task) => ({ ...task })),
    startedAt,
    finishedAt: Date.now(),
    tasks: results.map((task) => ({ ...task })),
  });

  try {
    for (const [stageIndex, stage] of params.stages.entries()) {
      if (signal?.aborted) throw signal.reason ?? new Error("Workflow aborted");
      const stageName = stage.name?.trim() || `stage-${stageIndex + 1}`;
      activeStage = stageName;
      const jobs = stage.tasks.map((task) => {
        const handoff = (task.inputs ?? [])
          .map((id) => byId.get(id))
          .filter(
            (result): result is WorkflowTaskResult => result !== undefined,
          )
          .map(taskOutput)
          .join("\n\n");
        if (Buffer.byteLength(handoff, "utf8") > MAX_HANDOFF_BYTES) {
          throw new Error(
            `Task "${task.id}" inputs exceed the ${MAX_HANDOFF_BYTES}-byte handoff limit. Reduce or summarize the upstream results.`,
          );
        }
        const prompt = handoff
          ? `${task.task}\n\nInputs from earlier workflow tasks:\n${handoff}`
          : task.task;
        const snapshot = manager.spawn({
          task: prompt,
          effort: task.effort,
          workspace: task.workspace,
          schema: task.schema,
          ctx,
        });
        startedIds.push(snapshot.id);
        return { task, snapshot };
      });
      activeTasks = jobs.map(({ task, snapshot }) => ({
        id: task.id,
        stage: stageName,
        allowFailure: task.allow_failure === true,
        snapshot,
      }));
      onProgress?.(current(true));

      const settled = await manager.wait(
        jobs.map(({ snapshot }) => snapshot.id),
        signal,
      );
      activeTasks = [];
      for (const [index, snapshot] of settled.entries()) {
        const task = jobs[index].task;
        const result: WorkflowTaskResult = {
          id: task.id,
          stage: stageName,
          allowFailure: task.allow_failure === true,
          snapshot,
        };
        results.push(result);
        byId.set(task.id, result);
      }
      onProgress?.(current(true));

      const failed = results.find(
        (result) =>
          result.stage === stageName &&
          !result.snapshot.success &&
          !result.allowFailure,
      );
      if (failed) {
        return current(
          false,
          `Task "${failed.id}" failed: ${failed.snapshot.error ?? failed.snapshot.status}`,
        );
      }
    }
    activeStage = undefined;
    return current(true);
  } catch (error) {
    const active = manager
      .list(startedIds)
      .filter(
        (snapshot) =>
          snapshot.status === "queued" || snapshot.status === "running",
      )
      .map((snapshot) => snapshot.id);
    if (active.length > 0) await manager.cancel(active);
    throw error;
  }
}
