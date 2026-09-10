import assert from "node:assert/strict";
import type { TSchema } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { Check } from "typebox/value";
import { unsafeFixture } from "../../test/adapter.ts";
import extension from "../index.ts";

const textContent = Schema.Array(
	Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);

const metadata = Schema.Struct({
	id: Schema.String,
	state: Schema.String,
	stdoutBytes: Schema.Finite,
	stdout: Schema.optionalKey(Schema.Never),
	stderr: Schema.optionalKey(Schema.Never),
});

const startResult = Schema.Struct({
	content: textContent,
	details: Schema.Struct({ id: Schema.String, pid: Schema.Finite }),
});

const statusResult = Schema.Struct({ content: textContent, details: metadata });

const listResult = Schema.Struct({
	content: textContent,
	details: Schema.Struct({ terminals: Schema.Array(metadata) }),
});

const killResult = Schema.Struct({ content: textContent });

export const decodeMessage = Schema.decodeUnknownSync(
	Schema.Struct({
		customType: Schema.String,
		content: Schema.String,
		details: Schema.Struct({ ids: Schema.Array(Schema.String) }),
	}),
);

export type DeliveryMessage = ReturnType<typeof decodeMessage>;

export type DeliveryOptions = Parameters<ExtensionAPI["sendMessage"]>[1];

export function testContext({
	ui,
	...context
}: Omit<Partial<ExtensionContext>, "ui"> & {
	ui?: Partial<ExtensionContext["ui"]>;
}) {
	const fixture = unsafeFixture<ExtensionContext>(context);

	if (ui) fixture.ui = unsafeFixture<ExtensionContext["ui"]>(ui);

	return fixture;
}

type ToolParams =
	| { command: string; title: string; working_dir?: string }
	| { id: string }
	| { ids: readonly string[] }
	| Record<string, never>;

type SDKEvents = { [Event in ExtensionEvent as Event["type"]]: Event };

type Handlers = {
	[Name in keyof SDKEvents]?: ExtensionHandler<SDKEvents[Name], unknown>;
};

type RegisteredTool = Pick<ToolDefinition, "name" | "executionMode"> & {
	execute(
		id: string,
		params: ToolParams,
		signal: AbortSignal | undefined,
		update: undefined,
		context: ExtensionContext,
	): ReturnType<ToolDefinition["execute"]>;
};

export function registeredExtension(
	sendMessage: (
		message: DeliveryMessage,
		options: DeliveryOptions,
	) => void = () => {},
) {
	const definitions: RegisteredTool[] = [];
	const handlers: Handlers = {};
	extension(
		unsafeFixture<ExtensionAPI>({
			events: {
				emit() {},
				on() {
					return () => {};
				},
			},
			on<Name extends keyof SDKEvents>(name: Name, handler: Handlers[Name]) {
				handlers[name] = handler;
			},
			registerCommand() {},
			registerTool<P extends TSchema, D, S>(tool: ToolDefinition<P, D, S>) {
				definitions.push({
					name: tool.name,
					executionMode: tool.executionMode,
					execute(id, params, signal, _update, context) {
						assert.ok(
							Check(tool.parameters, params),
							`Invalid ${tool.name} arguments`,
						);

						return tool.execute(id, params, signal, undefined, context);
					},
				});
			},
			sendMessage: ((message, options) =>
				sendMessage(
					decodeMessage(message),
					options,
				)) satisfies ExtensionAPI["sendMessage"],
		}),
	);

	function tool<S extends Schema.Top & { readonly DecodingServices: never }>(
		name: string,
		schema: S,
	) {
		const definition = definitions.find((entry) => entry.name === name);
		assert.ok(definition, `Missing tool ${name}`);

		return {
			name: definition.name,
			executionMode: definition.executionMode,
			execute(
				id: string,
				params: ToolParams,
				signal?: AbortSignal,
				update?: undefined,
				context: Pick<ExtensionContext, "cwd"> = { cwd: process.cwd() },
			) {
				return Effect.runPromise(
					Effect.promise(() =>
						definition.execute(
							id,
							params,
							signal,
							update,
							unsafeFixture<ExtensionContext>(context),
						),
					).pipe(Effect.map(Schema.decodeUnknownSync(schema))),
				);
			},
		};
	}

	return {
		tools: [
			tool("bg_start", startResult),
			tool("bg_status", statusResult),
			tool("bg_list", listResult),
			tool("bg_kill", killResult),
		] as const,
		handlers: {
			has(name: keyof SDKEvents) {
				return handlers[name] !== undefined;
			},
			get<Name extends keyof SDKEvents>(name: Name) {
				const handler = handlers[name];

				if (!handler) return undefined;

				return (event: Partial<SDKEvents[Name]>, context: ExtensionContext) =>
					Promise.resolve(
						handler(unsafeFixture<SDKEvents[Name]>(event), context),
					).then(() => undefined);
			},
		},
	};
}
