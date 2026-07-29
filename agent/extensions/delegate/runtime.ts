const { readFileSync } = process.getBuiltinModule("fs");
const { delimiter, join } = process.getBuiltinModule("path");

import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
	CHILD_EXTENSION_PATHS_ENV,
	type DelegateEffort,
	type DelegateThinking,
	RUN_TOOL_NAME,
	SESSION_TOOL_NAME,
} from "./contract.ts";
import { delegateError, errorMessage } from "./errors.ts";
import { cancelTimer, scheduleTimer } from "./host-timers.ts";

export const DELEGATION_TOOL_DENYLIST = [
	RUN_TOOL_NAME,
	SESSION_TOOL_NAME,
	"subagent",
	"subagent_status",
	"subagent_spawn",
	"subagent_wait",
	"subagent_cancel",
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

export const createChild = Effect.fn("createChild")(function* (
	cwd: string,
	model: ExtensionContext["model"],
	thinking: DelegateThinking,
) {
	const services = yield* Effect.context<never>();
	const resourceLoader = yield* Effect.try({
		try: () =>
			new DefaultResourceLoader({
				cwd,
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
				cwd,
				agentDir: getAgentDir(),
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
				model,
				thinkingLevel: thinking,
				excludeTools: [...DELEGATION_TOOL_DENYLIST],
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
							Effect.runSyncWith(services)(
								Effect.logError(`[delegate] ${failure.slice(0, 4_096)}`),
							);
							return;
						}
						throw new Error(failure);
					},
				})
				.finally(() => signal.removeEventListener("abort", onAbort));
		},
		catch: delegateError,
	}).pipe(
		Effect.tapError(() => Effect.promise(() => shutdownChild(result.session))),
	);

	result.session.setActiveToolsByName(
		selectChildToolNames(result.session.getAllTools()),
	);
	return result.session;
});

const CHILD_SHUTDOWN_MS = 7_500;
const childShutdowns = new WeakMap<object, Promise<void>>();

function waitBounded(operation: Promise<unknown>, timeoutMs: number) {
	let timer: ReturnType<typeof scheduleTimer> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = scheduleTimer(resolve, timeoutMs);
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
			if (timer) cancelTimer(timer);
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
