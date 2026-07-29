import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateUtf8Tail } from "../../lib/text.ts";
import { registerProcessStatusSource } from "../process-status/status.ts";
import {
	BackgroundTerminalManager,
	MAX_RUNNING_PER_OWNER,
	MAX_TRACKED,
	type TerminalSnapshot,
} from "./manager.ts";

const MAX_LINES = 80;
const MAX_TEXT = 24 * 1024;
const COMPLETION_TEXT_BYTES = 3_584;
const COMPLETION_BATCH_BYTES = 256 * 1024;
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 500] as const;

function sanitizeMultiline(text: string): string {
	let sanitized = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		sanitized +=
			(code === 9 ||
				code === 10 ||
				(code >= 32 && code < 127) ||
				code >= 160) &&
			!/\p{Cf}/u.test(character)
				? character
				: "�";
	}
	return sanitized;
}
function sanitizeInline(text: string): string {
	return sanitizeMultiline(text).replace(/\s+/gu, " ");
}
function sanitizeErrorForDisplay(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(sanitizeInline(message));
}
function tail(text: string, maxBytes = MAX_TEXT): string {
	return truncateUtf8Tail(sanitizeMultiline(text), maxBytes)
		.split("\n")
		.slice(-MAX_LINES)
		.join("\n");
}
function elapsed(snapshot: TerminalSnapshot): string {
	return `${Math.max(0, Math.round(((snapshot.settledAt ?? Date.now()) - snapshot.createdAt) / 1000))}s`;
}
function statusSummary(snapshot: TerminalSnapshot): string {
	const exit =
		snapshot.state === "running"
			? "running"
			: (snapshot.signal ??
				(snapshot.exitCode === undefined
					? snapshot.state
					: `exit ${snapshot.exitCode}`));
	return `[${snapshot.state}] ${sanitizeInline(snapshot.title)} · ${exit} · ${elapsed(snapshot)}`;
}
function summary(snapshot: TerminalSnapshot): string {
	return `${sanitizeInline(snapshot.id)} ${statusSummary(snapshot)}`;
}
function terminalMetadata(snapshot: TerminalSnapshot) {
	return {
		id: sanitizeInline(snapshot.id),
		title: sanitizeInline(snapshot.title),
		cwd: sanitizeInline(snapshot.cwd),
		pid: snapshot.pid,
		state: snapshot.state,
		exitCode: snapshot.exitCode,
		signal: snapshot.signal,
		stdoutBytes: snapshot.stdout.totalBytes,
		stderrBytes: snapshot.stderr.totalBytes,
	};
}
function formatTerminalDetails(
	snapshot: TerminalSnapshot,
	outputBytes = MAX_TEXT,
): string {
	const sections = [
		`command: ${sanitizeInline(snapshot.command)}`,
		`cwd: ${sanitizeInline(snapshot.cwd)}`,
	];
	for (const [name, output] of [
		["stdout", snapshot.stdout],
		["stderr", snapshot.stderr],
	] as const) {
		if (output.totalBytes === 0) continue;
		const omitted =
			output.truncatedBytes > 0
				? ` (${output.truncatedBytes} earlier bytes omitted)`
				: "";
		sections.push(`\n${name}${omitted}:\n${tail(output.text, outputBytes)}`);
	}
	if (snapshot.error)
		sections.push(`\nerror: ${sanitizeInline(snapshot.error)}`);
	if (snapshot.stdout.truncatedBytes || snapshot.stderr.truncatedBytes)
		sections.push("\noutput-retention: bounded-tail");
	return sections.join("\n");
}
function formatTerminalReport(
	snapshot: TerminalSnapshot,
	outputBytes = MAX_TEXT,
): string {
	return `${summary(snapshot)}\n${formatTerminalDetails(snapshot, outputBytes)}`;
}

export class BackgroundTerminalDelivery {
	private context?: ExtensionContext;
	private readonly pending = new Map<string, TerminalSnapshot>();
	private readonly attempts = new Map<string, number>();
	private readonly failed = new Set<string>();
	private retryTimer?: NodeJS.Timeout;
	private flushing = false;
	private closed = false;
	private readonly pi: Pick<ExtensionAPI, "sendMessage">;
	constructor(pi: Pick<ExtensionAPI, "sendMessage">) {
		this.pi = pi;
	}
	get problem(): string | undefined {
		if (this.failed.size === 0) return undefined;
		return `Automatic completion delivery failed for ${[...this.failed].join(", ")}. Use bg_status to inspect the retained result.`;
	}
	setContext(context: ExtensionContext) {
		this.context = context;
		this.closed = false;
	}
	private markFailed(id: string) {
		this.failed.add(id);
		if (this.failed.size > MAX_TRACKED)
			this.failed.delete(this.failed.values().next().value as string);
	}
	enqueue(snapshot: TerminalSnapshot) {
		if (this.closed || !this.context) return;
		if (!this.pending.has(snapshot.id) && this.pending.size === MAX_TRACKED) {
			const evicted = this.pending.keys().next().value as string;
			this.pending.delete(evicted);
			this.attempts.delete(evicted);
			this.markFailed(evicted);
			console.error(
				`[background-terminals] completion queue evicted ${evicted}; use bg_status to inspect it.`,
			);
		}
		this.pending.set(snapshot.id, snapshot);
		if (this.context.isIdle()) void this.flush();
	}
	consume(ids: readonly string[]) {
		for (const id of ids) {
			this.pending.delete(id);
			this.attempts.delete(id);
			this.failed.delete(id);
		}
	}
	private batch():
		| { snapshots: TerminalSnapshot[]; content: string }
		| undefined {
		const snapshots: TerminalSnapshot[] = [];
		const parts = ["[Background terminal results]\n\n"];
		let bytes = Buffer.byteLength(parts[0]);
		for (const snapshot of this.pending.values()) {
			if ((this.attempts.get(snapshot.id) ?? 0) >= MAX_DELIVERY_ATTEMPTS)
				continue;
			const rendered = formatTerminalReport(snapshot, COMPLETION_TEXT_BYTES);
			const separator = snapshots.length ? "\n\n---\n\n" : "";
			const addedBytes =
				Buffer.byteLength(separator) + Buffer.byteLength(rendered);
			if (snapshots.length && bytes + addedBytes > COMPLETION_BATCH_BYTES)
				break;
			if (bytes + addedBytes > COMPLETION_BATCH_BYTES) {
				const fallback = `${summary(snapshot)}\nCompletion detail exceeded the delivery limit; use bg_status ${snapshot.id}.`;
				parts.push(fallback);
				bytes += Buffer.byteLength(fallback);
			} else {
				parts.push(separator, rendered);
				bytes += addedBytes;
			}
			snapshots.push(snapshot);
		}
		return snapshots.length
			? { snapshots, content: parts.join("") }
			: undefined;
	}
	private scheduleRetry(attempt: number) {
		if (this.retryTimer || this.closed) return;
		this.retryTimer = setTimeout(
			() => {
				this.retryTimer = undefined;
				if (this.context?.isIdle()) void this.flush();
			},
			RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)],
		);
		this.retryTimer.unref();
	}
	async flush() {
		if (this.flushing || this.closed || !this.context) return;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.flushing = true;
		try {
			for (let sent = 0; sent < MAX_TRACKED; sent++) {
				const batch = this.batch();
				if (!batch) return;
				try {
					this.pi.sendMessage(
						{
							customType: "background-terminal-results",
							content: batch.content,
							display: true,
							details: { ids: batch.snapshots.map((snapshot) => snapshot.id) },
						},
						{
							deliverAs: "followUp",
							triggerTurn: batch.snapshots.some(
								(snapshot) => snapshot.state !== "done",
							),
						},
					);
					this.consume(batch.snapshots.map((snapshot) => snapshot.id));
				} catch (error) {
					let attempt = 0;
					for (const snapshot of batch.snapshots) {
						attempt = (this.attempts.get(snapshot.id) ?? 0) + 1;
						this.attempts.set(snapshot.id, attempt);
						if (attempt === MAX_DELIVERY_ATTEMPTS) this.markFailed(snapshot.id);
					}
					if (attempt < MAX_DELIVERY_ATTEMPTS) this.scheduleRetry(attempt);
					else
						console.error(
							`[background-terminals] completion delivery failed for ${batch.snapshots.map((snapshot) => snapshot.id).join(", ")}; use bg_status to inspect retained results: ${sanitizeInline(String(error).slice(0, 512))}`,
						);
					return;
				}
			}
		} finally {
			this.flushing = false;
		}
	}
	clear(): TerminalSnapshot[] {
		this.closed = true;
		this.context = undefined;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		const pending = [...this.pending.values()];
		this.pending.clear();
		this.attempts.clear();
		this.failed.clear();
		return pending;
	}
}

interface TerminalClient {
	delivery: BackgroundTerminalDelivery;
	updateStatus: () => void;
}

class BackgroundTerminalSession {
	// Every admitted delegate joins this parent-owned session; aggregate admission is intentionally unbounded and the parent shutdown clears all clients.
	private readonly clients = new Map<symbol, TerminalClient>();
	private readonly owners = new Map<string, symbol>();
	private readonly manager: BackgroundTerminalManager;
	private readonly owner: symbol;
	private stopping = false;

	constructor(owner: symbol, ownerClient: TerminalClient) {
		this.owner = owner;
		this.clients.set(owner, ownerClient);
		this.manager = new BackgroundTerminalManager(
			(snapshot, consumed) => {
				this.updateStatuses();
				if (consumed) {
					this.consume([snapshot.id]);
					return;
				}
				if (
					snapshot.state === "done" &&
					snapshot.stdout.totalBytes === 0 &&
					snapshot.stderr.totalBytes === 0 &&
					!snapshot.error
				)
					return;
				const holder = this.owners.get(snapshot.id);
				(holder ? this.clients.get(holder) : undefined)?.delivery.enqueue(
					snapshot,
				);
			},
			() => `bt-${++terminalSequence}`,
		);
	}

	join(id: symbol, client: TerminalClient) {
		if (this.stopping)
			throw new Error("Background terminal session is shutting down.");
		this.clients.set(id, client);
		client.updateStatus();
	}

	isOwner(id: symbol) {
		return id === this.owner;
	}

	start(
		client: symbol,
		options: { command: string; title: string; cwd: string },
	) {
		const running = this.list(client).filter(
			(snapshot) => snapshot.state === "running",
		).length;
		if (running >= MAX_RUNNING_PER_OWNER) {
			throw new Error(
				`Max ${MAX_RUNNING_PER_OWNER} background terminals can run concurrently per session; this session is running ${running}. Kill one with bg_kill or wait for one to settle.`,
			);
		}
		const snapshot = this.manager.start(options);
		this.owners.set(snapshot.id, client);
		const tracked = new Set(this.manager.list().map((entry) => entry.id));
		for (const id of this.owners.keys())
			if (!tracked.has(id)) this.owners.delete(id);
		this.updateStatuses();
		return snapshot;
	}

	list(client: symbol) {
		return this.manager
			.list()
			.filter((snapshot) => this.owners.get(snapshot.id) === client);
	}

	get(client: symbol, id: string) {
		return this.owners.get(id) === client ? this.manager.get(id) : undefined;
	}

	async kill(client: symbol, ids: readonly string[]) {
		for (const id of ids) {
			if (this.owners.get(id) !== client)
				throw new Error(`Unknown terminal id "${id}".`);
		}
		return this.manager.kill(ids);
	}

	consume(ids: readonly string[]) {
		for (const client of this.clients.values()) client.delivery.consume(ids);
	}

	private updateStatuses() {
		for (const client of this.clients.values()) client.updateStatus();
	}

	async leave(id: symbol) {
		const client = this.clients.get(id);
		if (!client) return;
		client.delivery.clear();
		this.clients.delete(id);
		if (id !== this.owner) {
			const held = this.list(id);
			for (const snapshot of held) this.owners.delete(snapshot.id);
			await this.manager.kill(
				held
					.filter((snapshot) => snapshot.state === "running")
					.map((snapshot) => snapshot.id),
			);
			this.updateStatuses();
			return;
		}

		this.stopping = true;
		if (activeTerminalSession === this) activeTerminalSession = undefined;
		for (const remaining of this.clients.values()) remaining.delivery.clear();
		this.clients.clear();
		this.owners.clear();
		await this.manager.shutdown();
	}
}

let activeTerminalSession: BackgroundTerminalSession | undefined;
let terminalSequence = 0;

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

	registerProcessStatusSource(pi, "background-terminals", () =>
		(session?.list(clientId) ?? []).map((snapshot) => ({
			id: snapshot.id,
			kind: "terminals" as const,
			active: snapshot.state === "running",
			summary: statusSummary(snapshot),
			detail: () => {
				const current = session?.get(clientId, snapshot.id);
				if (!current) throw new Error(`error=not-tracked id=${snapshot.id}`);
				return formatTerminalDetails(current);
			},
		})),
	);
	const leaveSession = async (keepContext: boolean) => {
		const joined = session;
		session = undefined;
		try {
			if (context?.hasUI)
				context.ui.setStatus("background-terminals", undefined);
		} catch {}
		lastStatus = null;
		if (!keepContext) context = undefined;
		await joined?.leave(clientId);
		if (keepContext && context) {
			delivery.setContext(context);
			if (!activeTerminalSession)
				activeTerminalSession = new BackgroundTerminalSession(clientId, client);
			else activeTerminalSession.join(clientId, client);
			session = activeTerminalSession;
			updateStatus();
		}
	};

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		delivery.setContext(ctx);
		if (!session) {
			// The enclosing session binds extensions before its in-process delegates,
			// so the first client owns the shared process lifetime.
			if (!activeTerminalSession)
				activeTerminalSession = new BackgroundTerminalSession(clientId, client);
			else activeTerminalSession.join(clientId, client);
			session = activeTerminalSession;
		}
		updateStatus();
	});
	pi.on("agent_end", async () => {
		if (context && !context.hasUI && session?.isOwner(clientId))
			await leaveSession(true);
	});
	pi.on("agent_settled", () => delivery.flush());
	pi.on("session_shutdown", () => leaveSession(false));

	const listText = (entries: TerminalSnapshot[]) => {
		const terminals = entries.length
			? entries.map(summary).join("\n")
			: "No background terminals.";
		return delivery.problem ? `${terminals}\n${delivery.problem}` : terminals;
	};

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
		async execute(_id, params, _signal, _update, ctx) {
			const command = params.command.trim();
			if (!command) throw new Error("command must not be empty.");
			const cwd = resolve(ctx.cwd, params.working_dir ?? ".");
			let cwdIsDirectory = false;
			try {
				cwdIsDirectory = statSync(cwd).isDirectory();
			} catch {}
			if (!cwdIsDirectory)
				throw new Error(
					`working_dir is not a directory: ${sanitizeInline(cwd)}`,
				);
			let snapshot: TerminalSnapshot;
			try {
				snapshot = currentSession().start(clientId, {
					command,
					title:
						[...sanitizeInline(params.title).trim()].slice(0, 80).join("") ||
						"terminal",
					cwd,
				});
			} catch (error) {
				throw sanitizeErrorForDisplay(error);
			}
			updateStatus();
			return {
				content: [
					{
						type: "text",
						text: `Started ${summary(snapshot)}\nOnly the newest 256 KiB per stream is retained; redirect explicitly for durable/full logs.`,
					},
				],
				details: terminalMetadata(snapshot),
			};
		},
	});
	pi.registerTool({
		name: "bg_status",
		label: "Background Terminal Status",
		description:
			"Show a background terminal's state and bounded stdout/stderr tails.",
		parameters: Type.Object({ id: Type.String({ maxLength: 64 }) }),
		executionMode: "parallel",
		async execute(_id, params) {
			const terminalSession = currentSession();
			const snapshot = terminalSession.get(clientId, params.id);
			if (!snapshot)
				throw new Error(`Unknown terminal id "${sanitizeInline(params.id)}".`);
			if (snapshot.state !== "running") terminalSession.consume([snapshot.id]);
			return {
				content: [{ type: "text", text: formatTerminalReport(snapshot) }],
				details: terminalMetadata(snapshot),
			};
		},
	});
	pi.registerTool({
		name: "bg_list",
		label: "List Background Terminals",
		description:
			"List session-scoped tracked background terminals without their output.",
		parameters: Type.Object({}),
		executionMode: "parallel",
		async execute() {
			const entries = currentSession().list(clientId);
			return {
				content: [
					{
						type: "text",
						text: listText(entries),
					},
				],
				details: { terminals: entries.map(terminalMetadata) },
			};
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
		async execute(_id, params, signal) {
			const ids = [...new Set(params.ids)];
			if (signal?.aborted)
				throw new Error("Kill aborted before termination started.");
			const terminalSession = currentSession();
			const work = terminalSession.kill(clientId, ids).catch((error) => {
				throw sanitizeErrorForDisplay(error);
			});
			let abort: (() => void) | undefined;
			if (signal) {
				try {
					await Promise.race([
						work,
						new Promise<never>((_, reject) => {
							abort = () =>
								reject(
									new Error(
										"Kill wait aborted; termination continues in the background.",
									),
								);
							signal.addEventListener("abort", abort, { once: true });
						}),
					]);
				} finally {
					if (abort) signal.removeEventListener("abort", abort);
				}
			}
			const results = await work;
			terminalSession.consume(ids);
			return {
				content: [
					{
						type: "text",
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
		},
	});
}
