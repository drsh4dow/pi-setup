import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionContext,
  getAgentDir,
  type ModelRegistry,
  SessionManager,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  CHILD_EXTENSION_PATHS_ENV,
  type DelegateEffort,
  type DelegateThinking,
  MAX_CHILD_OUTPUT_BYTES,
  RUN_TOOL_NAME,
  SESSION_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
} from "./contract.ts";
import { delegateError, errorMessage } from "./errors.ts";

export const DELEGATION_TOOL_DENYLIST = [
  RUN_TOOL_NAME,
  SESSION_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  "subagent",
  "subagent_status",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "workflow",
  "ask_user",
  "ask_questions",
] as const;

export type ChildSession = Awaited<
  ReturnType<typeof createAgentSession>
>["session"];

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

export { modelName };

interface DelegateModelSetting {
  model?: string;
  problem?: string;
}

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
    return { problem: `"delegate" in ${settingsPath} must be an object.` };
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

export interface DelegateModelChoice {
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

function boundedJsonSchema(schema: unknown): schema is Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return true;
    }
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) {
      return (
        value.length <= 1_000 && value.every((item) => visit(item, depth + 1))
      );
    }
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    return Object.keys(value).every(
      (key) =>
        key !== "__proto__" &&
        key !== "constructor" &&
        key !== "prototype" &&
        visit((value as Record<string, unknown>)[key], depth + 1),
    );
  };
  return visit(schema, 0);
}

export interface CreateChildOptions {
  schema?: unknown;
  captureStructured?: (value: unknown) => void;
}

function structuredOutputTool(options: CreateChildOptions): ToolDefinition[] {
  if (options.schema === undefined) return [];
  if (!boundedJsonSchema(options.schema)) {
    throw new Error("Structured output schema must be a bounded JSON object.");
  }
  return [
    defineTool({
      name: "structured_output",
      label: "Structured Output",
      description:
        "Return the final result matching the required schema. Call this exactly once as your final action.",
      parameters: Type.Unsafe(options.schema),
      async execute(_toolCallId, params) {
        let json: string;
        try {
          json = JSON.stringify(params);
        } catch {
          throw new Error("Structured output must be JSON serializable.");
        }
        if (Buffer.byteLength(json, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
          throw new Error(
            `Structured output exceeds ${MAX_CHILD_OUTPUT_BYTES} bytes.`,
          );
        }
        options.captureStructured?.(params);
        return {
          content: [{ type: "text", text: "Structured result recorded." }],
          details: params,
          terminate: true,
        };
      },
    }),
  ];
}

export function createChild(
  ctx: ExtensionContext,
  model: ExtensionContext["model"],
  thinking: DelegateThinking,
  options: CreateChildOptions = {},
) {
  return Effect.gen(function* () {
    const resourceLoader = yield* Effect.try({
      try: () =>
        new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          additionalExtensionPaths: childExtensionPaths(),
          systemPrompt: fileURLToPath(new URL("./SYSTEM.md", import.meta.url)),
          appendSystemPromptOverride: () => [],
        }),
      catch: delegateError,
    });
    yield* Effect.tryPromise({
      try: () => resourceLoader.reload(),
      catch: delegateError,
    });
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        createAgentSession({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          resourceLoader,
          sessionManager: SessionManager.inMemory(ctx.cwd),
          model,
          thinkingLevel: thinking,
          excludeTools: [...DELEGATION_TOOL_DENYLIST],
          customTools: structuredOutputTool(options),
        }).then(async (created) => {
          if (!signal.aborted) return created;
          await shutdownChild(created.session);
          throw signal.reason ?? new Error("Child session creation aborted.");
        }),
      catch: delegateError,
    });
    yield* Effect.tryPromise({
      try: (signal) => {
        const onAbort = () => void shutdownChild(result.session);
        signal.addEventListener("abort", onAbort, { once: true });
        return result.session
          .bindExtensions({
            mode: "print",
            onError: ({ extensionPath, event, error }) => {
              const failure = `Child extension ${extensionPath} failed during ${event}: ${error}`;
              if (event === "agent_end" || event === "session_shutdown") {
                console.error(`[delegate] ${failure.slice(0, 4_096)}`);
                return;
              }
              throw new Error(failure);
            },
          })
          .finally(() => signal.removeEventListener("abort", onAbort));
      },
      catch: delegateError,
    }).pipe(
      Effect.tapError(() =>
        Effect.promise(() => shutdownChild(result.session)),
      ),
    );

    result.session.setActiveToolsByName(
      selectChildToolNames(result.session.getAllTools()),
    );
    return result.session;
  });
}

const CHILD_SHUTDOWN_MS = 7_500;
const childShutdowns = new WeakMap<object, Promise<void>>();

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    timeout,
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

export function shutdownChild(child: ChildSession): Promise<void> {
  const existing = childShutdowns.get(child);
  if (existing) return existing;
  const shutdown = (async () => {
    if (child.isStreaming) await waitBounded(child.abort(), CHILD_SHUTDOWN_MS);
    try {
      if (child.extensionRunner.hasHandlers("session_shutdown")) {
        await waitBounded(
          child.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          }),
          CHILD_SHUTDOWN_MS,
        );
      }
    } catch {
      // Teardown must still dispose a child when an extension hook fails.
    } finally {
      try {
        child.dispose();
      } catch {
        // Disposal is terminal and idempotent at this ownership seam.
      }
    }
  })();
  childShutdowns.set(child, shutdown);
  return shutdown;
}
