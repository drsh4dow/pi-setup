import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateUtf8Head } from "../../lib/text.ts";
import { registerProcessStatusSource } from "../process-status/status.ts";
import {
  CONTROL_TOOL_NAME,
  DelegateControlParams,
  type DelegateDetails,
  DelegateParams,
  type DelegateSnapshot,
  DelegateWorkflowParams,
  TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from "./contract.ts";
import { formatStatusParts } from "./format.ts";
import { DelegateManager } from "./manager.ts";
import { formatDelegateOutput, formatSnapshotOutput } from "./output.ts";
import { renderDelegateCall, renderDelegateResult } from "./render.ts";
import {
  runWorkflow,
  type WorkflowResult,
  type WorkflowTaskResult,
} from "./workflow.ts";

export {
  CHILD_EXTENSION_PATHS_ENV,
  type DelegateDetails,
  type DelegateEffort,
  type DelegateOutput,
  type DelegateThinking,
  type DelegateUsageStats,
} from "./contract.ts";
export { extractAssistantText, formatDelegateOutput } from "./output.ts";
export {
  childExtensionPaths,
  DELEGATION_TOOL_DENYLIST,
  readDelegateModelSetting,
  resolveDelegateModel,
  selectChildToolNames,
  thinkingForEffort,
} from "./runtime.ts";

const MAX_TRACKED_WORKFLOWS = 64;

interface TrackedWorkflowTask {
  id: string;
  stage: string;
  delegateId: string;
  summary: string;
}

export interface TrackedWorkflow {
  id: string;
  status: "running" | "done" | "error";
  startedAt: number;
  settledAt?: number;
  stage: string;
  settledTasks: number;
  totalTasks: number;
  tasks: TrackedWorkflowTask[];
  activeTasks: TrackedWorkflowTask[];
  activity: Array<{ task: string; text: string }>;
  error?: string;
}

function statusSummary(snapshot: DelegateSnapshot) {
  const status = snapshot.status.replace("_", " ");
  const resumable = snapshot.resumable ? " · resumable" : "";
  return `[${status}] ${snapshot.workspace} · ${formatStatusParts(snapshot)}${resumable}`;
}

function summary(snapshot: DelegateSnapshot) {
  return `${snapshot.id} ${statusSummary(snapshot)}`;
}

function delegateDetail(manager: DelegateManager, id: string) {
  const snapshot = manager.list([id])[0];
  const lines = [
    `task: ${snapshot.assignedTask}`,
    `model: ${snapshot.model ?? snapshot.requestedModel}`,
    `workspace: ${snapshot.workspace}`,
    `tool-calls: ${snapshot.toolCalls}`,
    `tool-errors: ${snapshot.failedToolCalls}`,
  ];
  if (snapshot.error) lines.push(`error: ${snapshot.error}`);
  const activity = manager.recentActivity(id);
  lines.push(
    "",
    "activity:",
    activity.length > 0 ? activity.join("\n\n---\n\n") : "  -",
  );
  return lines.join("\n");
}

function workflowSummary(workflow: TrackedWorkflow) {
  const elapsed = Math.max(
    0,
    Math.round(
      ((workflow.settledAt ?? Date.now()) - workflow.startedAt) / 1000,
    ),
  );
  return `[${workflow.status}] stage=${workflow.stage} · tasks=${workflow.settledTasks}/${workflow.totalTasks} · elapsed=${elapsed}s`;
}

function trackedWorkflowTasks(tasks: readonly WorkflowTaskResult[]) {
  return tasks.map((task) => ({
    id: task.id,
    stage: task.stage,
    delegateId: task.snapshot.id,
    summary: statusSummary(task.snapshot),
  }));
}

function retainWorkflowActivity(
  manager: DelegateManager,
  workflow: TrackedWorkflow,
  tasks: readonly TrackedWorkflowTask[],
) {
  for (const task of tasks) {
    let items: readonly string[];
    try {
      items = manager.recentActivity(task.delegateId);
    } catch {
      continue;
    }
    if (items.length === 0) continue;
    const existing = workflow.activity.findIndex(
      (entry) => entry.task === task.id,
    );
    if (existing >= 0) workflow.activity.splice(existing, 1);
    workflow.activity.push({
      task: task.id,
      text: truncateUtf8Head(
        items.slice(-3).join("\n\n---\n\n"),
        4 * 1024,
        "\n[truncated]",
      ),
    });
    if (workflow.activity.length > 8) workflow.activity.shift();
  }
}

export function workflowDetail(
  manager: DelegateManager,
  workflow: TrackedWorkflow,
) {
  const tasks = [...workflow.tasks, ...workflow.activeTasks];
  const lines = [
    `stage: ${workflow.stage}`,
    `progress: ${workflow.settledTasks}/${workflow.totalTasks}`,
  ];
  retainWorkflowActivity(manager, workflow, tasks);
  if (workflow.error) lines.push(`error: ${workflow.error}`);
  lines.push("", "tasks:");
  if (tasks.length === 0) lines.push("  -");
  for (const task of tasks) {
    let summary = task.summary;
    try {
      summary = statusSummary(manager.list([task.delegateId])[0]);
    } catch {}
    lines.push(`${task.id} (${task.stage}) · ${task.delegateId} ${summary}`);
  }
  lines.push("", "activity:");
  if (workflow.activity.length === 0) lines.push("  -");
  for (const activity of [...workflow.activity].reverse()) {
    lines.push("", `${activity.task}:`, activity.text);
  }
  return lines.join("\n");
}

async function resultText(snapshots: DelegateSnapshot[]) {
  const sections: string[] = [];
  for (const snapshot of snapshots) {
    let text = summary(snapshot);
    if (snapshot.error) text += `\nError: ${snapshot.error}`;
    const output = formatSnapshotOutput(snapshot, 2);
    if (output) text += `\n\n${output}`;
    sections.push(text);
  }
  return (await formatDelegateOutput(sections.join("\n\n---\n\n"))).text;
}

async function workflowText(result: WorkflowResult) {
  const lines = [
    `Workflow ${result.success ? "completed" : "failed"}: ${result.tasks.filter((task) => task.snapshot.success).length}/${result.tasks.length} tasks succeeded.`,
  ];
  if (result.error) lines.push(`Error: ${result.error}`);
  for (const task of result.tasks) {
    lines.push(
      `- ${task.id} (${task.stage}): ${task.snapshot.status}${task.snapshot.error ? ` — ${task.snapshot.error}` : ""}`,
    );
  }
  const outputs = result.tasks
    .filter((task) => task.snapshot.success)
    .map(
      (task) =>
        `## ${task.id}\n${formatSnapshotOutput(task.snapshot, 2) || "(no output)"}`,
    );
  if (outputs.length > 0) lines.push("", ...outputs);
  return (await formatDelegateOutput(lines.join("\n"))).text;
}

export class BackgroundDelivery {
  private context: ExtensionContext | undefined;
  private readonly pending = new Map<string, DelegateSnapshot>();
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly render: typeof resultText;
  private flushing = false;

  constructor(
    pi: Pick<ExtensionAPI, "sendMessage">,
    render: typeof resultText = resultText,
  ) {
    this.pi = pi;
    this.render = render;
  }

  setContext(context: ExtensionContext) {
    this.context = context;
  }

  clear() {
    this.context = undefined;
    this.pending.clear();
  }

  consume(ids: readonly string[]) {
    for (const id of ids) this.pending.delete(id);
  }

  enqueue(snapshot: DelegateSnapshot) {
    if (!this.context) return;
    this.pending.set(snapshot.id, snapshot);
    if (this.context.isIdle()) void this.flush();
  }

  async flush() {
    if (this.flushing || !this.context || this.pending.size === 0) return;
    this.flushing = true;
    let sent = false;
    try {
      const candidates = [...this.pending.values()];
      const candidateContent = await this.render(candidates);
      if (!this.context) return;
      const snapshots = candidates.filter(
        (snapshot) => this.pending.get(snapshot.id) === snapshot,
      );
      if (snapshots.length === 0) return;
      const content =
        snapshots.length === candidates.length
          ? candidateContent
          : await this.render(snapshots);
      if (!this.context) return;
      this.pi.sendMessage(
        {
          customType: "delegate-results",
          content: `[Background delegation results]\n\n${content}`,
          display: true,
          details: { ids: snapshots.map((snapshot) => snapshot.id) },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      this.consume(
        snapshots
          .filter((snapshot) => this.pending.get(snapshot.id) === snapshot)
          .map((snapshot) => snapshot.id),
      );
      sent = true;
    } catch {
      // Keep results pending for the next idle/settled delivery attempt.
    } finally {
      this.flushing = false;
      if (sent && this.context?.isIdle() && this.pending.size > 0) {
        void this.flush();
      }
    }
  }
}

export default function delegateExtension(pi: ExtensionAPI) {
  const delivery = new BackgroundDelivery(pi);
  const manager = new DelegateManager({
    onSettled: (snapshot) => delivery.enqueue(snapshot),
  });
  const workflows = new Map<string, TrackedWorkflow>();
  let nextWorkflowId = 0;

  registerProcessStatusSource(pi, "delegate", () => [
    ...manager.list().map((snapshot) => ({
      id: snapshot.id,
      kind: "subagents" as const,
      active: snapshot.status === "queued" || snapshot.status === "running",
      summary: `${statusSummary(snapshot)} · ${snapshot.assignedTask}`,
      detail: () => delegateDetail(manager, snapshot.id),
    })),
    ...[...workflows.values()].map((workflow) => ({
      id: workflow.id,
      kind: "workflows" as const,
      active: workflow.status === "running",
      summary: workflowSummary(workflow),
      detail: () => workflowDetail(manager, workflow),
    })),
  ]);

  pi.on("session_start", (_event, ctx) => delivery.setContext(ctx));
  pi.on("agent_settled", () => delivery.flush());
  pi.on("session_shutdown", async () => {
    delivery.clear();
    await manager.shutdown();
  });

  pi.registerTool<typeof DelegateParams, DelegateDetails>({
    name: TOOL_NAME,
    label: "Delegate",
    description:
      "Run one fresh child agent and wait for its final result. Use this blocking path for isolated broad scans, current docs/API research, noisy debugging, plan critique, or an explicitly requested independent review. Do not use it for trivial work. Optional JSON Schema output provides a reliable typed result. The parent owns implementation and final validation by default. Children have fresh context but share the working tree; set workspace=write for any task that may edit so it runs exclusively. Use delegate_control for background work or messaging and delegate_workflow for staged fan-out.",
    promptSnippet:
      "Run one fresh child agent and wait for its result; mandatory for an explicitly requested independent review",
    promptGuidelines: [
      "Use delegate early when isolated context helps; it is mandatory when the user explicitly requests child delegation or an independent/fresh review.",
      "Use delegate_control start for background work and delegate_workflow for staged fan-out; do not delegate trivial tasks answerable with one or two cheap local calls.",
      "Mark every task that may modify files as workspace=write. Shared-write jobs run exclusively; filesystem isolation is not provided.",
      "Parent owns implementation, final validation, and the user-facing answer unless child implementation is explicitly assigned.",
      "Fast is the default. Use thorough only when explicitly requested, after fast demonstrates reasoning-limited uncertainty, or when an error is costly and hard to detect or rerun.",
    ],
    parameters: DelegateParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const snapshot = manager.spawn({
        task: params.task,
        effort: params.effort,
        workspace: params.workspace,
        schema: params.schema,
        ctx,
      });
      const unsubscribe = manager.subscribe((update) => {
        if (update.id !== snapshot.id) return;
        onUpdate?.({
          content: [{ type: "text", text: `Delegating (${update.effort})...` }],
          details: update,
        });
      });
      try {
        const [result] = await manager.wait([snapshot.id], signal);
        if (!result.success) {
          const reason = result.error ?? result.status;
          throw new Error(
            `Delegated task failed: ${reason} (${formatStatusParts(result)})`,
          );
        }
        const output = await formatDelegateOutput(
          formatSnapshotOutput(result, 2) ||
            "Delegated task completed without a final response.",
        );
        return {
          content: [{ type: "text", text: output.text }],
          details: {
            ...result,
            outputTruncated: output.truncation?.truncated,
            fullOutputFile: output.fullOutputFile,
          },
        };
      } catch (error) {
        if (signal?.aborted) await manager.cancel([snapshot.id]);
        throw error;
      } finally {
        unsubscribe();
      }
    },
    renderCall: renderDelegateCall,
    renderResult: renderDelegateResult,
  });

  pi.registerTool({
    name: CONTROL_TOOL_NAME,
    label: "Delegate Control",
    description:
      "Manage background child agents. start returns immediately and may require JSON Schema output; wait collects one or more results without cancelling them when the wait is interrupted; send steers a running child or continues a retained session; cancel stops work; status inspects tracked children. At most four read children run together, while write children run exclusively.",
    promptSnippet:
      "Start, wait for, message, cancel, or inspect bounded background child agents",
    promptGuidelines: [
      "After starting background children, continue useful parent work. Wait only when blocked on their results.",
      "Use send to add information or redirect a running child; settled sessions are resumable only while retained.",
      "Never overlap workspace writes: classify modifying tasks as workspace=write.",
    ],
    parameters: DelegateControlParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.action === "start") {
        if (!params.task) throw new Error("start requires task.");
        const snapshot = manager.spawn({
          task: params.task,
          effort: params.effort,
          workspace: params.workspace,
          schema: params.schema,
          background: true,
          ctx,
        });
        return {
          content: [
            {
              type: "text",
              text: `${summary(snapshot)}\nResult will be delivered automatically; use wait only when blocked.`,
            },
          ],
          details: snapshot,
        };
      }

      if (params.action === "send") {
        if (!params.id || !params.message) {
          throw new Error("send requires id and message.");
        }
        const snapshot = await manager.send(params.id, params.message);
        return {
          content: [
            { type: "text", text: `Message sent. ${summary(snapshot)}` },
          ],
          details: snapshot,
        };
      }

      const ids = params.ids ?? (params.id ? [params.id] : []);
      if (params.action === "wait") {
        if (ids.length === 0) throw new Error("wait requires ids.");
        delivery.consume(ids);
        const snapshots = await manager.wait(ids, signal);
        return {
          content: [{ type: "text", text: await resultText(snapshots) }],
          details: { results: snapshots },
        };
      }
      if (params.action === "cancel") {
        if (ids.length === 0) throw new Error("cancel requires ids.");
        delivery.consume(ids);
        const snapshots = await manager.cancel(ids);
        return {
          content: [{ type: "text", text: await resultText(snapshots) }],
          details: { results: snapshots },
        };
      }

      const snapshots = manager.list(ids.length > 0 ? ids : undefined);
      return {
        content: [
          {
            type: "text",
            text:
              snapshots.length > 0
                ? snapshots.map(summary).join("\n")
                : "No delegates are tracked.",
          },
        ],
        details: { results: snapshots },
      };
    },
  });

  pi.registerTool({
    name: WORKFLOW_TOOL_NAME,
    label: "Delegate Workflow",
    description:
      "Run an inspectable staged workflow through the same child manager. Stages execute sequentially; tasks within a stage execute concurrently under the global four-child cap. Later tasks can name earlier task ids as inputs. Optional JSON Schemas require structured_output. Failures stop the workflow unless allow_failure=true. A write task must be alone in its stage.",
    promptSnippet:
      "Run sequential stages with bounded parallel child tasks and structured handoffs",
    promptGuidelines: [
      "Use delegate_workflow for multi-step fan-out/fan-in work. Keep a single child task in delegate.",
      "Use schemas when later tasks branch on results; reference only earlier-stage task ids in inputs.",
      "Put each workspace-writing task in its own stage.",
    ],
    parameters: DelegateWorkflowParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (workflows.size >= MAX_TRACKED_WORKFLOWS) {
        const settled = [...workflows.values()].find(
          (workflow) => workflow.status !== "running",
        );
        if (!settled) {
          throw new Error(
            `error=workflow-registry-full running=${MAX_TRACKED_WORKFLOWS} max=${MAX_TRACKED_WORKFLOWS}`,
          );
        }
        workflows.delete(settled.id);
      }
      const id = `workflow-${++nextWorkflowId}`;
      const workflow: TrackedWorkflow = {
        id,
        status: "running",
        startedAt: Date.now(),
        stage: params.stages[0]?.name?.trim() || "stage-1",
        settledTasks: 0,
        totalTasks: params.stages.reduce(
          (count, stage) => count + stage.tasks.length,
          0,
        ),
        tasks: [],
        activeTasks: [],
        activity: [],
      };
      workflows.set(id, workflow);
      try {
        const result = await runWorkflow(
          manager,
          params,
          ctx,
          signal,
          (progress) => {
            workflow.settledTasks = progress.tasks.length;
            workflow.tasks = trackedWorkflowTasks(progress.tasks);
            workflow.activeTasks = trackedWorkflowTasks(progress.activeTasks);
            retainWorkflowActivity(manager, workflow, [
              ...workflow.tasks,
              ...workflow.activeTasks,
            ]);
            if (progress.activeStage) workflow.stage = progress.activeStage;
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `workflow: running settled=${progress.tasks.length} total=${workflow.totalTasks}`,
                },
              ],
              details: progress,
            });
          },
        );
        workflow.status = result.success ? "done" : "error";
        workflow.settledAt = Date.now();
        workflow.settledTasks = result.tasks.length;
        workflow.tasks = trackedWorkflowTasks(result.tasks);
        workflow.activeTasks = [];
        retainWorkflowActivity(manager, workflow, workflow.tasks);
        workflow.error = result.error
          ? truncateUtf8Head(result.error, 4 * 1024, "\n[truncated]")
          : undefined;
        return {
          content: [{ type: "text", text: await workflowText(result) }],
          details: result,
        };
      } catch (error) {
        workflow.status = "error";
        workflow.settledAt = Date.now();
        workflow.error = truncateUtf8Head(
          error instanceof Error ? error.message : String(error),
          4 * 1024,
          "\n[truncated]",
        );
        throw error;
      }
    },
  });
}
