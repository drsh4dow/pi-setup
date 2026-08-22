import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Layer, Path } from "effect";
import { COMPACTION_DELIVERY_PAUSE_CHANNEL } from "../compaction/index.ts";
import { registerProcessStatusSource } from "../process-status/status.ts";
import {
	BackgroundTerminalDelivery,
	formatTerminalDetails,
	formatTerminalReport,
	sanitizeErrorForDisplay,
	sanitizeInline,
	statusSummary,
	summary,
	terminalMetadata,
} from "./delivery.ts";
import {
	type BackgroundTerminalSession,
	joinBackgroundTerminalSession,
} from "./session.ts";

export { BackgroundTerminalDelivery } from "./delivery.ts";

const platformLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

export default function backgroundTerminals(pi: ExtensionAPI) {
	const delivery = new BackgroundTerminalDelivery(pi);
	const clientId = Symbol("background-terminal-client");
	let context: ExtensionContext | undefined;
	let session: BackgroundTerminalSession | undefined;
	let lastStatus: string | undefined | null = null;
	const currentSession = () => {
		if (!session)
			throw new Error(
				"Background terminals are unavailable before session start.",
			);
		return session;
	};
	const updateStatus = () => {
		if (!session) return;
		const running = session
			.list(clientId)
			.filter((snapshot) => snapshot.state === "running").length;
		const status = running ? `${running} bg · /ps` : undefined;
		if (status === lastStatus) return;
		try {
			if (!context?.hasUI) return;
			context.ui.setStatus("background-terminals", status);
			lastStatus = status;
		} catch {
			// A client can outlive its context, which rejects every access once stale.
			lastStatus = null;
		}
	};
	const client = { delivery, updateStatus };

	registerProcessStatusSource(pi, "background-terminals", () => {
		if (!session) return [];
		return session.list(clientId).map((snapshot) => ({
			id: snapshot.id,
			kind: "terminals" as const,
			active: snapshot.state === "running",
			summary: statusSummary(snapshot),
			detail: () => {
				const current = session?.get(clientId, snapshot.id);
				if (!current) throw new Error(`error=not-tracked id=${snapshot.id}`);
				return formatTerminalDetails(current);
			},
		}));
	});
	const leaveSession = Effect.fn("leaveSession")(function* (
		keepContext: boolean,
	) {
		const joined = session;
		session = undefined;
		yield* Effect.try({
			try: () =>
				context?.hasUI &&
				context.ui.setStatus("background-terminals", undefined),
			catch: () => undefined,
		}).pipe(Effect.ignore);
		lastStatus = null;
		if (!keepContext) context = undefined;
		if (joined) yield* joined.leave(clientId);
		if (keepContext && context) {
			delivery.setContext(context);
			session = joinBackgroundTerminalSession(clientId, client);
			updateStatus();
		}
	});

	pi.events.on(COMPACTION_DELIVERY_PAUSE_CHANNEL, (paused) => {
		if (typeof paused === "boolean") delivery.setPaused(paused);
	});
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		delivery.setContext(ctx);
		if (!session) session = joinBackgroundTerminalSession(clientId, client);
		updateStatus();
	});
	pi.on("agent_end", () =>
		context && !context.hasUI && session?.isOwner(clientId)
			? Effect.runPromise(leaveSession(true))
			: undefined,
	);
	pi.on("agent_settled", () => Effect.runPromise(delivery.flush));
	pi.on("session_shutdown", () => Effect.runPromise(leaveSession(false)));

	pi.registerTool({
		name: "bg_start",
		label: "Start Background Terminal",
		description:
			"Start a non-interactive, session-scoped shell command in the background. Only bounded output tails are retained; redirect explicitly for durable/full logs.",
		promptSnippet:
			"Start a long-running non-interactive command and continue useful work instead of polling",
		promptGuidelines: [
			"Use meaningful titles and avoid duplicate servers or watchers.",
			"Never use for interactive commands. Background commands and delegated children share the worktree without write isolation; avoid overlapping mutations.",
		],
		parameters: Type.Object({
			command: Type.String({ maxLength: 100_000 }),
			title: Type.String({ maxLength: 160 }),
			working_dir: Type.Optional(Type.String({ maxLength: 4_096 })),
		}),
		executionMode: "parallel",
		execute(_id, params, _signal, _update, ctx) {
			return Effect.runPromise(
				Effect.gen(function* () {
					const command = params.command.trim();
					if (!command) throw new Error("command must not be empty.");
					const fs = yield* FileSystem.FileSystem;
					const path = yield* Path.Path;
					const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
					const cwdIsDirectory = yield* fs.stat(cwd).pipe(
						Effect.map((info) => info.type === "Directory"),
						Effect.orElseSucceed(() => false),
					);
					if (!cwdIsDirectory)
						throw new Error(
							`working_dir is not a directory: ${sanitizeInline(cwd)}`,
						);
					const snapshot = yield* Effect.sync(() => {
						try {
							return currentSession().start(clientId, {
								command,
								title:
									[...sanitizeInline(params.title).trim()]
										.slice(0, 80)
										.join("") || "terminal",
								cwd,
							});
						} catch (error) {
							throw sanitizeErrorForDisplay(error);
						}
					});
					updateStatus();
					return {
						content: [
							{
								type: "text" as const,
								text: `Started ${summary(snapshot)}\nOnly the newest 256 KiB per stream is retained; redirect explicitly for durable/full logs.`,
							},
						],
						details: terminalMetadata(snapshot),
					};
				}).pipe(Effect.provide(platformLayer)),
			);
		},
	});
	pi.registerTool({
		name: "bg_status",
		label: "Background Terminal Status",
		description:
			"Show a background terminal's state and bounded stdout/stderr tails.",
		parameters: Type.Object({ id: Type.String({ maxLength: 64 }) }),
		executionMode: "parallel",
		execute(_id, params) {
			return Effect.runPromise(
				Effect.sync(() => {
					const terminalSession = currentSession();
					const snapshot = terminalSession.get(clientId, params.id);
					if (!snapshot)
						throw new Error(
							`Unknown terminal id "${sanitizeInline(params.id)}".`,
						);
					if (snapshot.state !== "running")
						terminalSession.consume([snapshot.id]);
					return {
						content: [{ type: "text", text: formatTerminalReport(snapshot) }],
						details: terminalMetadata(snapshot),
					};
				}),
			);
		},
	});
	pi.registerTool({
		name: "bg_list",
		label: "List Background Terminals",
		description:
			"List session-scoped tracked background terminals without their output.",
		parameters: Type.Object({}),
		executionMode: "parallel",
		execute() {
			return Effect.runPromise(
				Effect.sync(() => {
					const entries = currentSession().list(clientId);
					const terminals = entries.length
						? entries.map(summary).join("\n")
						: "No background terminals.";
					return {
						content: [
							{
								type: "text",
								text: delivery.problem
									? `${terminals}\n${delivery.problem}`
									: terminals,
							},
						],
						details: { terminals: entries.map(terminalMetadata) },
					};
				}),
			);
		},
	});
	pi.registerTool({
		name: "bg_kill",
		label: "Kill Background Terminals",
		description:
			"Terminate background process trees with bounded SIGTERM-to-SIGKILL escalation.",
		parameters: Type.Object({
			ids: Type.Array(Type.String({ maxLength: 64 }), {
				minItems: 1,
				maxItems: 16,
			}),
		}),
		executionMode: "parallel",
		execute(_id, params, signal) {
			const ids = [...new Set(params.ids)];
			const terminalSession = currentSession();
			let killError: unknown;
			const work = Effect.runPromise(
				Effect.suspend(() => terminalSession.kill(clientId, ids)),
			);
			work.catch((error) => {
				killError = error;
			});
			return Effect.runPromise(
				Effect.promise(() => work).pipe(
					Effect.map((results) => {
						terminalSession.consume(ids);
						return {
							content: [
								{
									type: "text" as const,
									text: results
										.map(
											(result) =>
												`${result.id} [${result.state}] ${sanitizeInline(result.title)}${result.killed ? " · killed" : " · already settled"}`,
										)
										.join("\n"),
								},
							],
							details: {
								results: results.map((result) => ({
									...result,
									title: sanitizeInline(result.title),
								})),
							},
						};
					}),
				),
				{ signal },
			).catch((error) => {
				// An abort only interrupts the wait. A failure of the kill itself
				// must surface even when the signal is also aborted.
				if (killError !== undefined) throw sanitizeErrorForDisplay(killError);
				throw sanitizeErrorForDisplay(
					signal?.aborted
						? new Error(
								"Kill wait aborted; termination continues in the background.",
							)
						: error,
				);
			});
		},
	});
}
