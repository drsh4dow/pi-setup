import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Exit } from "effect";
import {
  CHILD_EXTENSION_PATHS_ENV,
  type DelegateDetails,
  type DelegateEffort,
  type DelegateParams,
  type DelegateParams as DelegateParamsSchema,
  type DelegateThinking,
  type DelegateUsageStats,
  TIMEOUT_MS,
  TOOL_NAME,
} from "./contract.ts";
import { DelegateTimeout, delegateError, errorMessage } from "./errors.ts";
import { formatStatusParts } from "./format.ts";
import { extractAssistantText, formatDelegateOutputEffect } from "./output.ts";

const DELEGATE_PROMPT = `You are Pi running as a delegated child agent in a fresh context. Parent called you as a bounded tool, not as the conversation owner.

Mission:
- Complete only the assigned task. Do not continue the parent conversation or expand scope.
- Use normal Pi/project instructions, tools, and current repository context as needed.
- If the task is read-only, do not write files or run state-changing commands. If edits are allowed, make focused, reversible changes only; do not commit, revert unrelated work, or touch unrelated files.
- Inspect before acting. Prefer root-cause fixes, local reasoning, simple designs, and clear evidence over speculation.
- Preserve context: use tools deliberately, keep exploration out of the final answer, and never include scratchpad or transcript.
- Evidence before claims: cite files, symbols, commands, outcomes, or URLs. Verify important claims when practical; source inspection is valid evidence for read-only recon.
- If blocked or uncertain, do the smallest useful investigation and report the blocker instead of guessing.

Task modes:
- Scout/research/review: report facts, risks, and concrete next steps. Do not edit unless the task explicitly permits edits.
- Implementation/debugging: change only what is needed, then run the most relevant checks practical for the change.

Final report:
- Task: one-line assigned task.
- Result: concise outcome.
- Evidence: bullets with relevant files, symbols, commands, outcomes, or URLs.
- Files: inspected/changed paths only.
- Verification: commands run and outcomes, or "not run" with reason.
- Handoff: decisions, risks, or next steps for the parent only when important.

Use the shortest useful report, usually 10-25 lines. Return only the final report.`;

export const DELEGATION_TOOL_DENYLIST = [
  TOOL_NAME,
  "subagent",
  "subagent_status",
] as const;

type ChildSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type DelegateExecute = NonNullable<
  ToolDefinition<typeof DelegateParamsSchema, DelegateDetails>["execute"]
>;

interface DelegateState {
  readonly startedAt: number;
  readonly effort: DelegateEffort;
  readonly thinking: DelegateThinking;
  readonly assignedTask: string;
  readonly requestedModel: string;
  readonly fallbackReason?: string;
  readonly childUsage: DelegateUsageStats;
  model?: string;
  toolCalls: number;
  failedToolCalls: number;
  lastAssistantText: string;
}

export function thinkingForEffort(effort: DelegateEffort): DelegateThinking {
  return effort === "fast" ? "low" : "high";
}

export function selectChildToolNames(
  tools: Pick<ToolInfo, "name">[],
): string[] {
  const deny = new Set<string>(DELEGATION_TOOL_DENYLIST);
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    if (deny.has(tool.name) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    selected.push(tool.name);
  }

  return selected;
}

function normalizeEffort(effort: DelegateParams["effort"]): DelegateEffort {
  return effort === "thorough" ? "thorough" : "fast";
}

function modelName(
  model: { provider?: unknown; id?: unknown } | undefined,
): string | undefined {
  if (
    !model ||
    typeof model.provider !== "string" ||
    typeof model.id !== "string"
  ) {
    return undefined;
  }
  return `${model.provider}/${model.id}`;
}

interface DelegateModelSetting {
  model?: string;
  problem?: string;
}

/**
 * Read the optional `{"delegate": {"model": "provider/model-id"}}` section of
 * Pi's global settings.json. Malformed settings never fail the delegation;
 * they surface as a problem that becomes the fallback reason.
 */
export function readDelegateModelSetting(
  settingsPath = join(getAgentDir(), "settings.json"),
): DelegateModelSetting {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    return {
      problem: `Could not read ${settingsPath}: ${errorMessage(error)}.`,
    };
  }

  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch (error) {
    return {
      problem: `Could not parse ${settingsPath}: ${errorMessage(error)}.`,
    };
  }

  const delegate = (settings as { delegate?: unknown } | null)?.delegate;
  if (delegate === undefined) return {};
  if (!delegate || typeof delegate !== "object" || Array.isArray(delegate)) {
    return {
      problem: `"delegate" in ${settingsPath} must be an object.`,
    };
  }
  const model = (delegate as { model?: unknown }).model;
  if (model === undefined) return {};
  if (typeof model !== "string" || model.trim() === "") {
    return {
      problem: `"delegate.model" in ${settingsPath} must be a "provider/model-id" string.`,
    };
  }
  return { model: model.trim() };
}

interface DelegateModelChoice {
  model: ExtensionContext["model"];
  requestedModel: string;
  fallbackReason?: string;
}

export function resolveDelegateModel(
  ctx: {
    model: ExtensionContext["model"];
    modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">;
  },
  setting: DelegateModelSetting = readDelegateModelSetting(),
): DelegateModelChoice {
  const parentModel = (
    requestedModel: string,
    problem?: string,
  ): DelegateModelChoice => {
    const noParent =
      "No parent model was available; Pi will use its normal session default.";
    return {
      model: ctx.model,
      requestedModel,
      fallbackReason: problem
        ? `${problem} ${ctx.model ? "Using the parent model instead." : noParent}`
        : ctx.model
          ? undefined
          : noParent,
    };
  };

  if (setting.problem) return parentModel("parent model", setting.problem);
  if (!setting.model) return parentModel("parent model");

  const slash = setting.model.indexOf("/");
  if (slash <= 0 || slash === setting.model.length - 1) {
    return parentModel(
      setting.model,
      `Configured delegate model "${setting.model}" must be a "provider/model-id" string.`,
    );
  }
  const model = ctx.modelRegistry.find(
    setting.model.slice(0, slash),
    setting.model.slice(slash + 1),
  );
  if (!model) {
    return parentModel(
      setting.model,
      `Configured delegate model "${setting.model}" was not found in the model registry.`,
    );
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    return parentModel(
      setting.model,
      `Configured delegate model "${setting.model}" has no auth configured.`,
    );
  }
  return { model, requestedModel: setting.model };
}

export function childExtensionPaths(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of (env[CHILD_EXTENSION_PATHS_ENV] ?? "").split(delimiter)) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function emptyUsageStats(): DelegateUsageStats {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function detailsFrom(state: DelegateState): DelegateDetails {
  return {
    success: false,
    assignedTask: state.assignedTask,
    effort: state.effort,
    requestedModel: state.requestedModel,
    model: state.model,
    thinking: state.thinking,
    fallbackReason: state.fallbackReason,
    durationMs: Date.now() - state.startedAt,
    toolCalls: state.toolCalls,
    failedToolCalls: state.failedToolCalls,
    childUsage: { ...state.childUsage },
    timedOut: false,
    aborted: false,
  };
}

function updateUsage(state: DelegateState, event: AgentSessionEvent): void {
  if (event.type !== "message_end") return;

  const text = extractAssistantText(event.message);
  if (text) state.lastAssistantText = text;
  if (event.message.role !== "assistant") return;

  const usage = event.message.usage as
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: { total?: number };
      }
    | undefined;
  state.childUsage.turns++;
  state.childUsage.input += usage?.input ?? 0;
  state.childUsage.output += usage?.output ?? 0;
  state.childUsage.cacheRead += usage?.cacheRead ?? 0;
  state.childUsage.cacheWrite += usage?.cacheWrite ?? 0;
  state.childUsage.totalTokens += usage?.totalTokens ?? 0;
  state.childUsage.cost += usage?.cost?.total ?? 0;
}

function abortChild(child: ChildSession): Effect.Effect<void> {
  if (!child.isStreaming) return Effect.void;
  return Effect.tryPromise({
    try: () => child.abort(),
    catch: delegateError,
  }).pipe(Effect.timeout(5_000), Effect.ignore);
}

function createChild(
  ctx: ExtensionContext,
  model: ExtensionContext["model"],
  thinking: DelegateThinking,
) {
  return Effect.gen(function* () {
    const resourceLoader = yield* Effect.try({
      try: () =>
        new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          additionalExtensionPaths: childExtensionPaths(),
          appendSystemPrompt: [DELEGATE_PROMPT],
        }),
      catch: delegateError,
    });
    yield* Effect.tryPromise({
      try: () => resourceLoader.reload(),
      catch: delegateError,
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        createAgentSession({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          resourceLoader,
          sessionManager: SessionManager.inMemory(ctx.cwd),
          model,
          thinkingLevel: thinking,
        }),
      catch: delegateError,
    });
    return result.session;
  });
}

function disposeChild(child: ChildSession) {
  return Effect.try({
    try: () => child.dispose(),
    catch: delegateError,
  });
}

export const executeDelegate: DelegateExecute = async (
  _toolCallId,
  params,
  signal,
  onUpdate,
  ctx,
) => {
  const effort = normalizeEffort(params.effort);
  const modelChoice = resolveDelegateModel(ctx);
  const state: DelegateState = {
    startedAt: Date.now(),
    effort,
    thinking: thinkingForEffort(effort),
    assignedTask: params.task,
    requestedModel: modelChoice.requestedModel,
    fallbackReason: modelChoice.fallbackReason,
    model: modelName(modelChoice.model),
    childUsage: emptyUsageStats(),
    toolCalls: 0,
    failedToolCalls: 0,
    lastAssistantText: "",
  };

  const updateProgress = () => {
    onUpdate?.({
      content: [{ type: "text", text: `Delegating (${effort})...` }],
      details: detailsFrom(state),
    });
  };

  updateProgress();

  const program = Effect.acquireUseRelease(
    createChild(ctx, modelChoice.model, state.thinking),
    (child) => {
      state.model = modelName(child.model ?? modelChoice.model);
      return Effect.gen(function* () {
        yield* Effect.try({
          try: () =>
            child.setActiveToolsByName(
              selectChildToolNames(child.getAllTools()),
            ),
          catch: delegateError,
        });

        yield* Effect.acquireUseRelease(
          Effect.try({
            try: () =>
              child.subscribe((event) => {
                if (event.type === "tool_execution_start") {
                  state.toolCalls++;
                  updateProgress();
                }
                if (event.type === "tool_execution_end") {
                  if (event.isError) state.failedToolCalls++;
                  updateProgress();
                }
                updateUsage(state, event);
              }),
            catch: delegateError,
          }),
          () =>
            Effect.tryPromise({
              try: () =>
                child.prompt(params.task, {
                  expandPromptTemplates: false,
                  source: "extension",
                }),
              catch: delegateError,
            }).pipe(
              Effect.onInterrupt(() => abortChild(child)),
              Effect.timeoutOrElse({
                duration: TIMEOUT_MS,
                orElse: () =>
                  Effect.fail(
                    new DelegateTimeout({
                      message: `Timed out after ${TIMEOUT_MS / 60_000} minutes`,
                    }),
                  ),
              }),
            ),
          (unsubscribe) =>
            Effect.try({ try: unsubscribe, catch: delegateError }),
        );
      });
    },
    disposeChild,
  );

  const exit = await Effect.runPromiseExit(program, { signal });
  if (Exit.isFailure(exit)) {
    const aborted =
      Cause.hasInterruptsOnly(exit.cause) && signal?.aborted === true;
    const error = Cause.squash(exit.cause);
    const timedOut = error instanceof DelegateTimeout;
    const message = aborted ? "Delegation aborted" : errorMessage(error);
    const details = {
      ...detailsFrom(state),
      timedOut,
      aborted,
      error: message,
    };
    let failure = `Delegated task failed: ${message} (${formatStatusParts(details)}`;
    if (timedOut) failure += " • timed out";
    if (aborted) failure += " • aborted";
    failure += ")";
    throw new Error(failure, { cause: error });
  }

  const output = await Effect.runPromise(
    formatDelegateOutputEffect(
      state.lastAssistantText ||
        "Delegated task completed without a final text response.",
    ),
  );
  const details: DelegateDetails = {
    ...detailsFrom(state),
    success: true,
    outputTruncated: output.truncation?.truncated,
    fullOutputFile: output.fullOutputFile,
  };

  return {
    content: [{ type: "text", text: output.text }],
    details,
  };
};
