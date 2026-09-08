const { existsSync, readFileSync } = process.getBuiltinModule("fs");
const { delimiter, join } = process.getBuiltinModule("path");

import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Config, Effect } from "effect";
import {
	CHILD_EXTENSION_PATHS_ENV,
	type DelegateEffort,
	type DelegateThinking,
	RUN_TOOL_NAME,
	SESSION_TOOL_NAME,
} from "./contract.ts";
import { delegateError, errorMessage } from "./errors.ts";

export const DELEGATION_TOOL_DENYLIST = [
	RUN_TOOL_NAME,
	SESSION_TOOL_NAME,
	"subagent",
	"subagent_status",
	"subagent_spawn",
	"subagent_wait",
	"subagent_cancel",
	"ask_user",
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
	const denied = new Set<string>(DELEGATION_TOOL_DENYLIST);
	return [...new Set(tools.map((tool) => tool.name))].filter(
		(name) => !denied.has(name),
	);
}

export function modelName(
	model: { provider?: unknown; id?: unknown } | undefined,
): string | undefined {
	return typeof model?.provider === "string" && typeof model.id === "string"
		? `${model.provider}/${model.id}`
		: undefined;
}

type DelegateModelSetting = {
	model?: string;
	thinking?: DelegateThinking;
	problem?: string;
};

function readDelegateModelSources(
	sources: readonly { path: string; project: boolean }[],
	effort: DelegateEffort = "fast",
): DelegateModelSetting {
	const result: DelegateModelSetting = {};
	for (const source of sources) {
		let settings: unknown;
		try {
			settings = JSON.parse(readFileSync(source.path, "utf8"));
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				continue;
			}
			const action = error instanceof SyntaxError ? "parse" : "read";
			return {
				problem: `Could not ${action} ${source.path}: ${errorMessage(error)}.`,
			};
		}

		const delegate = source.project
			? settings
			: (settings as { delegate?: unknown } | null)?.delegate;
		if (delegate === undefined) continue;
		if (!delegate || typeof delegate !== "object" || Array.isArray(delegate)) {
			return {
				problem: source.project
					? `${source.path} must contain an object.`
					: `"delegate" in ${source.path} must be an object.`,
			};
		}
		const config = delegate as Record<string, unknown>;
		const profile = config[effort];
		if (
			profile !== undefined &&
			(!profile || typeof profile !== "object" || Array.isArray(profile))
		) {
			return { problem: `"${effort}" in ${source.path} must be an object.` };
		}
		const selected = profile as Record<string, unknown> | undefined;
		const thinking =
			selected?.thinking !== undefined ? selected.thinking : config.thinking;
		if (
			thinking !== undefined &&
			thinking !== "off" &&
			thinking !== "minimal" &&
			thinking !== "low" &&
			thinking !== "medium" &&
			thinking !== "high" &&
			thinking !== "xhigh" &&
			thinking !== "max"
		) {
			return {
				problem: `"thinking" in ${source.path} must be off, minimal, low, medium, high, xhigh, or max.`,
			};
		}
		if (result.thinking === undefined && thinking !== undefined)
			result.thinking = thinking;
		const model = selected?.model !== undefined ? selected.model : config.model;
		if (
			model !== undefined &&
			(typeof model !== "string" || model.trim() === "")
		) {
			return {
				problem: `"${source.project ? "model" : "delegate.model"}" in ${source.path} must be a "provider/model-id" string.`,
			};
		}
		if (result.model === undefined && typeof model === "string")
			result.model = model.trim();
		if (result.model !== undefined && result.thinking !== undefined)
			return result;
	}
	return result;
}

export function readDelegateModelSetting(
	settingsPath = join(getAgentDir(), "settings.json"),
	effort: DelegateEffort = "fast",
): DelegateModelSetting {
	return readDelegateModelSources(
		[{ path: settingsPath, project: false }],
		effort,
	);
}

export function readProjectDelegateModelSetting(
	cwd: string,
	options: {
		parentCwd?: string;
		settingsPath?: string;
		effort?: DelegateEffort;
	} = {},
): DelegateModelSetting {
	const projectCwds = [
		...new Set(options.parentCwd ? [cwd, options.parentCwd] : [cwd]),
	];
	return readDelegateModelSources(
		[
			...projectCwds.map((projectCwd) => ({
				path: join(projectCwd, ".pi", "delegate.json"),
				project: true,
			})),
			{
				path: options.settingsPath ?? join(getAgentDir(), "settings.json"),
				project: false,
			},
		],
		options.effort,
	);
}

export interface DelegateModelChoice {
	model: ExtensionContext["model"];
	requestedModel: string;
	fallbackReason?: string;
}

type DelegateModelContext = {
	model: ExtensionContext["model"];
	modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">;
};

function findConfiguredModel(
	registry: DelegateModelContext["modelRegistry"],
	spec: string,
): { model: NonNullable<ExtensionContext["model"]> } | { problem: string } {
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) {
		return { problem: `"${spec}" must be a "provider/model-id" string.` };
	}
	const model = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
	if (!model) {
		return { problem: `"${spec}" was not found in the model registry.` };
	}
	if (!registry.hasConfiguredAuth(model)) {
		return { problem: `"${spec}" has no auth configured.` };
	}
	return { model };
}

export function resolveRequestedModel(
	ctx: DelegateModelContext,
	spec: string,
): DelegateModelChoice {
	const requested = spec.trim();
	const found = findConfiguredModel(ctx.modelRegistry, requested);
	if ("problem" in found) {
		throw new Error(`Requested delegate model ${found.problem}`);
	}
	return { model: found.model, requestedModel: requested };
}

export function resolveDelegateModel(
	ctx: DelegateModelContext,
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

	const found = findConfiguredModel(ctx.modelRegistry, setting.model);
	if ("problem" in found) {
		return parentModel(
			setting.model,
			`Configured delegate model ${found.problem}`,
		);
	}
	return { model: found.model, requestedModel: setting.model };
}

export function childExtensionPaths(
	env: Record<string, string | undefined>,
): string[] {
	return [
		...new Set(
			(env[CHILD_EXTENSION_PATHS_ENV] ?? "")
				.split(delimiter)
				.map((path) => path.trim())
				.filter(Boolean),
		),
	];
}

export function createChildSessionManager(
	cwd: string,
	parent: ExtensionContext["sessionManager"],
): SessionManager {
	if (!parent.getSessionFile()) return SessionManager.inMemory(cwd);
	return SessionManager.create(
		cwd,
		join(parent.getSessionDir(), "delegates", parent.getSessionId()),
		{ parentSession: parent.getSessionFile() },
	);
}

export const createChild = Effect.fn("createChild")(function* (
	cwd: string,
	model: ExtensionContext["model"],
	thinking: DelegateThinking,
	agentDir = getAgentDir(),
	parentSessionManager?: ExtensionContext["sessionManager"],
) {
	const services = yield* Effect.context<never>();
	const extensionPaths = yield* Config.string(CHILD_EXTENSION_PATHS_ENV).pipe(
		Config.withDefault(""),
	);
	const projectSystemPrompt = join(cwd, ".pi", "DELEGATE_SYSTEM.md");
	const resourceLoader = yield* Effect.try({
		try: () =>
			new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: childExtensionPaths({
					[CHILD_EXTENSION_PATHS_ENV]: extensionPaths,
				}),
				systemPrompt: existsSync(projectSystemPrompt)
					? projectSystemPrompt
					: undefined,
				appendSystemPromptOverride: (prompts) => [
					...prompts,
					readFileSync(new URL("./SYSTEM.md", import.meta.url), "utf8"),
				],
			}),
		catch: delegateError,
	});
	yield* Effect.tryPromise({
		try: () => resourceLoader.reload(),
		catch: delegateError,
	});
	const result = yield* Effect.callback<
		Awaited<ReturnType<typeof createAgentSession>>,
		ReturnType<typeof delegateError>
	>((resume, signal) => {
		createAgentSession({
			cwd,
			agentDir,
			resourceLoader,
			sessionManager: parentSessionManager
				? createChildSessionManager(cwd, parentSessionManager)
				: SessionManager.inMemory(cwd),
			model,
			thinkingLevel: thinking,
			excludeTools: [...DELEGATION_TOOL_DENYLIST],
		}).then(
			(created) => {
				if (!signal.aborted) resume(Effect.succeed(created));
				else Effect.runForkWith(services)(shutdownChild(created.session));
			},
			(error) => resume(Effect.fail(delegateError(error))),
		);
	});
	yield* Effect.tryPromise({
		try: (signal) => {
			const onAbort = () =>
				Effect.runForkWith(services)(shutdownChild(result.session));
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
	}).pipe(Effect.tapError(() => shutdownChild(result.session)));

	result.session.setActiveToolsByName(
		selectChildToolNames(result.session.getAllTools()),
	);
	return result.session;
});

const CHILD_SHUTDOWN_MS = 7_500;
const childShutdowns = new WeakMap<object, Effect.Effect<void>>();

function waitBounded(operation: Promise<unknown>) {
	return Effect.promise(() => operation).pipe(
		Effect.exit,
		Effect.timeoutOption(CHILD_SHUTDOWN_MS),
		Effect.asVoid,
	);
}

export function shutdownChild(child: ChildSession): Effect.Effect<void> {
	const existing = childShutdowns.get(child);
	if (existing) return existing;
	const shutdown = Effect.runSync(
		Effect.cached(
			Effect.gen(function* () {
				if (child.isStreaming) yield* waitBounded(child.abort());
				if (child.extensionRunner.hasHandlers("session_shutdown")) {
					yield* waitBounded(
						child.extensionRunner.emit({
							type: "session_shutdown",
							reason: "quit",
						}),
					);
				}
				yield* Effect.try(() => child.dispose()).pipe(Effect.ignore);
			}),
		),
	);
	childShutdowns.set(child, shutdown);
	return shutdown;
}
