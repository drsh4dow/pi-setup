const { existsSync, readFileSync } = process.getBuiltinModule("fs");
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

type DelegateModelSetting = { model?: string; problem?: string };

export function readDelegateModelSetting(
	settingsPath = join(getAgentDir(), "settings.json"),
): DelegateModelSetting {
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return {};
		}
		const action = error instanceof SyntaxError ? "parse" : "read";
		return {
			problem: `Could not ${action} ${settingsPath}: ${errorMessage(error)}.`,
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

export const createChild = Effect.fn("createChild")(function* (
	cwd: string,
	model: ExtensionContext["model"],
	thinking: DelegateThinking,
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
				agentDir: getAgentDir(),
				additionalExtensionPaths: childExtensionPaths({
					[CHILD_EXTENSION_PATHS_ENV]: extensionPaths,
				}),
				systemPrompt: existsSync(projectSystemPrompt)
					? projectSystemPrompt
					: fileURLToPath(new URL("./SYSTEM.md", import.meta.url)),
				appendSystemPromptOverride: () => [],
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
			agentDir: getAgentDir(),
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
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
