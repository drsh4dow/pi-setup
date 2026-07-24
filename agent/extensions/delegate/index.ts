import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateUtf8Head } from "../../lib/text.ts";
import { registerProcessStatusSource } from "../process-status/status.ts";
import {
  type DelegateDetails,
  DelegateRunParams,
  DelegateSessionParams,
  type DelegateSnapshot,
  DelegateWorkflowParams,
  MAX_TRACKED_CHILDREN,
  RUN_TOOL_NAME,
  SESSION_TOOL_NAME,
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
const DELIVERY_RETRY_DELAYS_MS = [25, 100] as const;

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
  return `[${status}] ${snapshot.workspace} · ${formatStatusParts(snapshot)}`;
}

function summary(snapshot: DelegateSnapshot) {
  return `${snapshot.id} ${statusSummary(snapshot)}`;
}

function taskPreview(task: string) {
  const singleLine = task.replace(/\s+/g, " ").trim();
  return singleLine.length <= 160 ? singleLine : `${singleLine.slice(0, 159)}…`;
}

function sessionSummary(snapshot: DelegateSnapshot) {
  return `${summary(snapshot)} · ${taskPreview(snapshot.assignedTask) || "(empty task)"}`;
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
  private readonly pending = new Map<
    string,
    {
      snapshot: DelegateSnapshot;
      attempts: number;
      exhausted: boolean;
      diagnosed: boolean;
    }
  >();
  private readonly reservations = new Map<symbol, string | undefined>();
  private readonly pi: Pick<ExtensionAPI, "sendMessage">;
  private readonly render: typeof resultText;
  private readonly acknowledge: (ids: readonly string[]) => void;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private version = 0;

  constructor(
    pi: Pick<ExtensionAPI, "sendMessage">,
    render: typeof resultText = resultText,
    acknowledge: (ids: readonly string[]) => void = () => {},
  ) {
    this.pi = pi;
    this.render = render;
    this.acknowledge = acknowledge;
  }

  setContext(context: ExtensionContext) {
    this.context = context;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.version++;
    if (context.isIdle()) void this.flush();
  }

  clear() {
    this.context = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.pending.clear();
    this.reservations.clear();
    this.version++;
  }

  reserve(): symbol {
    if (this.reservations.size >= MAX_TRACKED_CHILDREN) {
      throw new Error(
        `Delegate registry is full (${MAX_TRACKED_CHILDREN} tracked children).`,
      );
    }
    const reservation = Symbol("delegate-delivery");
    this.reservations.set(reservation, undefined);
    this.version++;
    return reservation;
  }

  attach(reservation: symbol, snapshot: DelegateSnapshot) {
    if (!this.reservations.has(reservation)) {
      throw new Error("Background delivery reservation is no longer active.");
    }
    this.reservations.set(reservation, snapshot.id);
    this.version++;
  }

  release(reservation: symbol) {
    if (this.reservations.delete(reservation)) this.version++;
  }

  consume(snapshots: readonly DelegateSnapshot[]) {
    let changed = false;
    for (const snapshot of snapshots) {
      changed = this.pending.delete(snapshot.id) || changed;
      for (const [reservation, id] of this.reservations) {
        if (id !== snapshot.id) continue;
        this.reservations.delete(reservation);
        changed = true;
      }
    }
    if (changed) this.version++;
    this.acknowledge(snapshots.map((snapshot) => snapshot.id));
  }

  enqueue(snapshot: DelegateSnapshot) {
    if (!this.context) return;
    const existing = this.pending.get(snapshot.id);
    if (existing) existing.snapshot = snapshot;
    else {
      this.pending.set(snapshot.id, {
        snapshot,
        attempts: 0,
        exhausted: false,
        diagnosed: false,
      });
    }
    this.version++;
    if (this.context.isIdle()) void this.flush();
  }

  async flush() {
    const context = this.context;
    if (this.flushing || this.retryTimer || !context || this.pending.size === 0)
      return;
    const entries = [...this.pending.values()].filter(
      (entry) => !entry.exhausted,
    );
    if (entries.length === 0) return;
    this.flushing = true;
    const startVersion = this.version;
    const snapshots = entries.map((entry) => entry.snapshot);
    try {
      const content = await this.render(snapshots);
      if (
        this.context !== context ||
        entries.some((entry) => this.pending.get(entry.snapshot.id) !== entry)
      ) {
        return;
      }
      this.pi.sendMessage(
        {
          customType: "delegate-results",
          content: `[Background delegation results]\n\n${content}`,
          display: true,
          details: { ids: snapshots.map((snapshot) => snapshot.id) },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      this.consume(snapshots);
    } catch (error) {
      if (this.context !== context) return;
      const exhausted: string[] = [];
      let retryDelay: number | undefined;
      for (const entry of entries) {
        if (this.pending.get(entry.snapshot.id) !== entry) continue;
        entry.attempts++;
        if (entry.attempts > DELIVERY_RETRY_DELAYS_MS.length) {
          entry.exhausted = true;
          if (!entry.diagnosed) {
            entry.diagnosed = true;
            exhausted.push(entry.snapshot.id);
          }
        } else {
          retryDelay = Math.min(
            retryDelay ?? Number.POSITIVE_INFINITY,
            DELIVERY_RETRY_DELAYS_MS[entry.attempts - 1],
          );
        }
      }
      if (exhausted.length > 0) {
        const evidence = String(error).replace(/\s+/g, " ").slice(0, 512);
        for (const id of exhausted) {
          console.error(
            `[delegate] background delivery failed for ${id}; use delegate_session wait to recover retained results: ${evidence}`,
          );
        }
      }
      if (retryDelay !== undefined) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          if (this.context?.isIdle()) void this.flush();
        }, retryDelay);
        this.retryTimer.unref?.();
      }
    } finally {
      this.flushing = false;
      if (
        !this.retryTimer &&
        this.version !== startVersion &&
        this.context?.isIdle() &&
        [...this.pending.values()].some((entry) => !entry.exhausted)
      ) {
        void this.flush();
      }
    }
  }
}

export default function delegateExtension(pi: ExtensionAPI) {
  let manager!: DelegateManager;
  const delivery = new BackgroundDelivery(pi, resultText, (ids) =>
    manager.acknowledge(ids),
  );
  manager = new DelegateManager({
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

  pi.registerTool<typeof DelegateRunParams, DelegateDetails>({
    name: RUN_TOOL_NAME,
    label: "Delegate Run",
    description:
      "One new child: delegate_run. Existing child: delegate_session. Two or more tasks known in advance: delegate_workflow. Creates exactly one child with fresh context that cannot see the parent conversation, so task must be self-contained with the objective, relevant context/files, constraints, permissions, verification, and output contract. By default waits for the final result; background=true returns the child id immediately and automatically delivers completion later. Never start background then immediately wait; use blocking delegate_run. Parent owns implementation and final verification unless explicitly delegated. Children share the working tree; workspace=write runs exclusively.",
    promptSnippet:
      "Create exactly one fresh child, blocking by default or delivering later in background",
    promptGuidelines: [
      "One new child: delegate_run. Existing child: delegate_session. Two or more tasks known in advance: delegate_workflow.",
      "Child context is fresh and cannot see the parent conversation; every task must be self-contained.",
      "Never start background then immediately wait; use blocking delegate_run. For background runs, continue useful parent work and wait only when blocked.",
      "Parent owns implementation and final verification unless explicitly delegated.",
      "Mark every task that may modify files as workspace=write; shared-write jobs run exclusively without filesystem isolation.",
    ],
    parameters: DelegateRunParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const reservation = params.background ? delivery.reserve() : undefined;
      let snapshot: DelegateSnapshot;
      try {
        snapshot = manager.spawn({
          task: params.task,
          effort: params.effort,
          workspace: params.workspace,
          schema: params.schema,
          background: params.background,
          ctx,
        });
        if (reservation) delivery.attach(reservation, snapshot);
      } catch (error) {
        if (reservation) delivery.release(reservation);
        throw error;
      }
      if (params.background) {
        return {
          content: [
            {
              type: "text",
              text: `${summary(snapshot)}\nResult will be delivered automatically; continue useful work and wait only when blocked.`,
            },
          ],
          details: snapshot,
        };
      }
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

  pi.registerTool<typeof DelegateSessionParams, unknown>({
    name: SESSION_TOOL_NAME,
    label: "Delegate Session",
    description:
      "Existing child: delegate_session. One new child: delegate_run. Two or more tasks known in advance: delegate_workflow. Manages tracked children only and cannot create or resume one. list recovers all live-session child ids; status inspects without waiting; wait returns outputs; send steers one running child; cancel stops work. Settled children cannot receive more messages; use delegate_run with a new self-contained task instead. Never start background then immediately wait; use blocking delegate_run.",
    promptSnippet:
      "List, inspect, wait for, steer, or cancel existing child sessions",
    promptGuidelines: [
      "Use send only to steer a running child. A child sees its own session, not the parent conversation, so include any new context it needs.",
      "After a background run, continue useful parent work and wait only when blocked.",
      "A settled child is finished and cannot be resumed; use delegate_run for new work. Tracked ids last only for the current parent session.",
    ],
    parameters: DelegateSessionParams,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
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
      const ids = params.ids ?? [];
      if (params.action === "list") {
        const snapshots = manager.list();
        return {
          content: [
            {
              type: "text",
              text:
                snapshots.length > 0
                  ? snapshots.map(sessionSummary).join("\n")
                  : "No delegates are tracked.",
            },
          ],
          details: { results: snapshots },
        };
      }
      if (ids.length === 0)
        throw new Error("Provide at least one delegate id.");
      if (params.action === "wait") {
        const snapshots = await manager.wait(ids, signal);
        delivery.consume(snapshots);
        return {
          content: [{ type: "text", text: await resultText(snapshots) }],
          details: { results: snapshots },
        };
      }
      if (params.action === "cancel") {
        const snapshots = await manager.cancel(ids);
        delivery.consume(snapshots);
        return {
          content: [{ type: "text", text: await resultText(snapshots) }],
          details: { results: snapshots },
        };
      }
      const snapshots = manager.list(ids);
      return {
        content: [
          { type: "text", text: snapshots.map(sessionSummary).join("\n") },
        ],
        details: { results: snapshots },
      };
    },
  });

  pi.registerTool({
    name: WORKFLOW_TOOL_NAME,
    label: "Delegate Workflow",
    description:
      "Two or more tasks known in advance: delegate_workflow. One new child: delegate_run. Existing child: delegate_session. Blocks while running staged fan-out/fan-in: stages execute sequentially and tasks within a stage concurrently under the global four-child cap. Children have fresh context and cannot see the parent conversation, so every task must include its objective, relevant context/files, constraints, permissions, verification, and expected output. Earlier workflow inputs provide only declared outputs, not undeclared parent context. Parent owns implementation and final verification unless explicitly delegated. A write task must be alone in its stage.",
    promptSnippet:
      "Run sequential stages with bounded parallel child tasks and structured handoffs",
    promptGuidelines: [
      "Use delegate_workflow only for two or more predetermined tasks; use delegate_run for one new child and delegate_session for an existing child.",
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
