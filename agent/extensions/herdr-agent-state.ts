// Locally patched Herdr integration: reconcile idle state after missed lifecycle reports.
// Herdr integration updates overwrite this file; preserve this patch until upstreamed.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=8

import net from "node:net";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Config, Effect, Option, Schema } from "effect";

type AgentState = "working" | "blocked" | "idle";
type Request = {
	id: string;
	method: "pane.report_agent" | "pane.report_agent_session";
	params: Record<string, unknown>;
};

const acknowledgement = Schema.decodeUnknownOption(
	Schema.fromJsonString(
		Schema.Struct({
			id: Schema.String,
			result: Schema.Unknown,
			error: Schema.optionalKey(Schema.Never),
		}),
	),
);

export default function (pi: ExtensionAPI) {
	const config = Effect.runSync(
		Effect.all({
			enabled: Config.string("HERDR_ENV").pipe(Config.withDefault("")),
			socketPath: Config.string("HERDR_SOCKET_PATH").pipe(
				Config.withDefault(""),
			),
			paneId: Config.string("HERDR_PANE_ID").pipe(Config.withDefault("")),
		}),
	);
	if (config.enabled !== "1" || !config.socketPath || !config.paneId) return;
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\${config.socketPath}`
			: config.socketPath;
	let seq = Effect.runSync(Clock.currentTimeMillis) * 1000;
	let session: ReturnType<typeof createSession> | undefined;

	const attempt = Effect.fn("herdr.attempt")(function* (
		report: Request,
		timeout: number,
	) {
		return yield* Effect.callback<boolean>((resume) => {
			const socket = net.createConnection(endpoint);
			let buffer = "";
			let done = false;
			const finish = (delivered: boolean) => {
				if (done) return;
				done = true;
				socket.destroy();
				resume(Effect.succeed(delivered));
			};
			socket.setEncoding("utf8");
			socket.on("connect", () => socket.write(`${JSON.stringify(report)}\n`));
			socket.on("error", () => finish(false));
			socket.on("close", () => finish(false));
			socket.on("end", () => finish(false));
			socket.on("data", (chunk) => {
				buffer += chunk;
				const end = buffer.indexOf("\n");
				if (end < 0) return;
				const reply = acknowledgement(buffer.slice(0, end));
				finish(Option.isSome(reply) && reply.value.id === report.id);
			});
			return Effect.sync(() => {
				done = true;
				socket.destroy();
			});
		}).pipe(
			Effect.timeoutOption(timeout),
			Effect.map((result) => Option.getOrElse(result, () => false)),
		);
	});

	function createSession(initialContext: ExtensionContext) {
		let context = initialContext;
		let stopped = false;
		let blockedCount = 0;
		let blockedMessage: string | undefined;
		let desired: { state: AgentState; message: string | undefined } | undefined;
		let pending: Request | undefined;
		let pendingSession: Request | undefined;
		let cancelReporter: (() => void) | undefined;
		let cancelReconcile: (() => void) | undefined;

		function request(
			method: Request["method"],
			params: Request["params"],
		): Request {
			const file = context.sessionManager.getSessionFile();
			const id = context.sessionManager.getSessionId();
			const identity = file?.startsWith("/")
				? { agent_session_path: file }
				: id
					? { agent_session_id: id }
					: {};
			seq += 1;
			return {
				id: `herdr:pi:${seq}`,
				method,
				params: {
					pane_id: config.paneId,
					source: "herdr:pi",
					agent: "pi",
					seq,
					...identity,
					...params,
				},
			};
		}

		const drain = Effect.fn("herdr.drain")(function* () {
			while (!stopped && (pendingSession || pending)) {
				const report = pendingSession ?? pending;
				if (!report) break;
				const current = () => report === pendingSession || report === pending;
				let delivered = yield* attempt(report, 500);
				if (!delivered && current()) delivered = yield* attempt(report, 1500);
				// Identity reporting is best-effort; state reports also carry the identity.
				if (pendingSession === report) pendingSession = undefined;
				if (delivered) {
					if (pending === report) pending = undefined;
				} else if (pending === report) {
					// Keep failed delivery pending for the next reconciliation.
					break;
				}
			}
			cancelReporter = undefined;
		});

		function publish() {
			if (stopped) return;
			const state: AgentState =
				blockedCount > 0 ? "blocked" : context.isIdle() ? "idle" : "working";
			const message = blockedCount > 0 ? blockedMessage : undefined;
			if (state !== desired?.state || message !== desired?.message) {
				desired = { state, message };
				pending = request("pane.report_agent", { state, message });
			}
			if (!cancelReporter && (pendingSession || pending))
				cancelReporter = Effect.runCallback(drain());
			// Background processes do not keep Pi busy. Poll until idle is acknowledged.
			if (!cancelReconcile && (state !== "idle" || pending || pendingSession)) {
				cancelReconcile = Effect.runCallback(reconcile());
			}
		}

		const reconcile = Effect.fn("herdr.reconcile")(function* () {
			while (!stopped) {
				yield* Effect.sleep(1000);
				publish();
				if (desired?.state === "idle" && !pending && !pendingSession) break;
			}
			cancelReconcile = undefined;
		});

		return {
			update(ctx: ExtensionContext, reportSession: boolean, reason?: string) {
				context = ctx;
				if (reportSession)
					pendingSession = request("pane.report_agent_session", {
						session_start_source: reason,
					});
				publish();
			},
			blocked(data: unknown) {
				if (typeof data !== "object" || data === null) return;
				if (!("active" in data) || !data.active) {
					blockedCount = Math.max(0, blockedCount - 1);
					if (blockedCount === 0) blockedMessage = undefined;
				} else {
					blockedCount += 1;
					blockedMessage =
						"label" in data && typeof data.label === "string"
							? data.label
							: undefined;
				}
				publish();
			},
			stop() {
				stopped = true;
				cancelReporter?.();
				cancelReconcile?.();
			},
		};
	}

	pi.events.on("herdr:blocked", (data: unknown) => session?.blocked(data));
	pi.on("session_start", (event, ctx) => {
		session?.stop();
		session = undefined;
		// RPC also has hasUI=true. Only a TUI session owns the Herdr pane.
		if (ctx.mode !== "tui") return;
		session = createSession(ctx);
		session.update(ctx, true, event.reason);
	});
	pi.on("agent_start", (_event, ctx) => session?.update(ctx, true));
	pi.on("agent_settled", (_event, ctx) => session?.update(ctx, false));
	pi.on("session_shutdown", () => {
		session?.stop();
		session = undefined;
	});
}
