import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import { truncateUtf8Tail } from "../../lib/text.ts";
import {
	MAX_TRACKED,
	type SettledTerminalSnapshot,
	type TerminalSnapshot,
	terminalResultFields,
} from "./manager.ts";
import type { RunningTerminalNotification } from "./notifications.ts";

const MAX_LINES = 80;
const MAX_TEXT = 24 * 1024;
const COMPLETION_TEXT_BYTES = 3_584;
const COMPLETION_BATCH_BYTES = 256 * 1024;
const MAX_DELIVERY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 500] as const;
const logError = (message: string) => Effect.runSync(Effect.logError(message));

export function sanitizeMultiline(text: string): string {
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
export function sanitizeInline(text: string): string {
	return sanitizeMultiline(text).replace(/\s+/gu, " ");
}
export function sanitizeErrorForDisplay(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(sanitizeInline(message));
}
function tail(text: string, maxBytes = MAX_TEXT): string {
	// Sanitization can expand each replaced character to three bytes.
	const bounded = truncateUtf8Tail(text, maxBytes * 3);
	return truncateUtf8Tail(sanitizeMultiline(bounded), maxBytes)
		.split("\n")
		.slice(-MAX_LINES)
		.join("\n");
}
function elapsed(snapshot: TerminalSnapshot): string {
	const end =
		snapshot.state === "running"
			? Effect.runSync(Clock.currentTimeMillis)
			: snapshot.settledAt;
	return `${Math.max(0, Math.round((end - snapshot.createdAt) / 1000))}s`;
}
export function statusSummary(snapshot: TerminalSnapshot): string {
	const fields = terminalResultFields(snapshot);
	const exit =
		snapshot.state === "running"
			? "running"
			: (fields.signal ??
				(fields.exitCode === undefined
					? snapshot.state
					: `exit ${fields.exitCode}`));
	return `[${snapshot.state}] ${sanitizeInline(snapshot.title)} · ${exit} · ${elapsed(snapshot)}`;
}
export function summary(snapshot: TerminalSnapshot): string {
	return `${sanitizeInline(snapshot.id)} ${statusSummary(snapshot)}`;
}
export function terminalMetadata(snapshot: TerminalSnapshot) {
	const fields = terminalResultFields(snapshot);
	return {
		id: sanitizeInline(snapshot.id),
		title: sanitizeInline(snapshot.title),
		cwd: sanitizeInline(snapshot.cwd),
		pid: snapshot.pid,
		state: snapshot.state,
		exitCode: fields.exitCode,
		signal: fields.signal,
		stdoutBytes: snapshot.stdout.totalBytes,
		stderrBytes: snapshot.stderr.totalBytes,
	};
}
export function formatTerminalDetails(
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
	const error = terminalResultFields(snapshot).error;
	if (error) sections.push(`\nerror: ${sanitizeInline(error)}`);
	if (snapshot.stdout.truncatedBytes || snapshot.stderr.truncatedBytes)
		sections.push("\noutput-retention: bounded-tail");
	return sections.join("\n");
}
export function formatTerminalReport(
	snapshot: TerminalSnapshot,
	outputBytes = MAX_TEXT,
): string {
	return `${summary(snapshot)}\n${formatTerminalDetails(snapshot, outputBytes)}`;
}

function formatTerminalNotification(
	notification: RunningTerminalNotification,
): string {
	return `${sanitizeInline(notification.terminalId)} [running] ${sanitizeInline(notification.title)}\n${tail(notification.message)}`;
}

export class BackgroundTerminalDelivery {
	private context?: ExtensionContext;
	private readonly pending = new Map<string, SettledTerminalSnapshot>();
	private readonly notificationPending = new Map<
		string,
		RunningTerminalNotification
	>();
	private readonly attempts = new Map<string, number>();
	private readonly failed = new Set<string>();
	private retryGeneration = 0;
	private flushState: "idle" | "flushing" = "idle";
	private lifecycle: "open" | "closed" = "closed";
	private paused = false;
	private readonly pi: Pick<ExtensionAPI, "sendMessage">;
	private readonly reportError: (message: string) => void;
	constructor(
		pi: Pick<ExtensionAPI, "sendMessage">,
		reportError: (message: string) => void = logError,
	) {
		this.pi = pi;
		this.reportError = reportError;
	}
	get problem(): string | undefined {
		if (this.failed.size === 0) return undefined;
		return `Automatic background-terminal delivery failed for ${[...this.failed].join(", ")}. Use bg_status to inspect terminal state.`;
	}
	setContext(context: ExtensionContext) {
		this.context = context;
		this.lifecycle = "open";
		this.paused = false;
	}
	setPaused(paused: boolean) {
		if (this.paused === paused) return;
		this.paused = paused;
		if (!paused && this.context?.isIdle()) Effect.runFork(this.flush);
	}
	private markFailed(id: string) {
		this.failed.add(id);
		if (this.failed.size <= MAX_TRACKED) return;
		const oldest = this.failed.values().next();
		if (!oldest.done) this.failed.delete(oldest.value);
	}
	enqueue(snapshot: SettledTerminalSnapshot) {
		if (this.lifecycle === "closed" || !this.context) return;
		if (!this.pending.has(snapshot.id) && this.pending.size === MAX_TRACKED) {
			const oldest = this.pending.keys().next();
			if (!oldest.done) {
				this.pending.delete(oldest.value);
				this.attempts.delete(oldest.value);
				this.markFailed(oldest.value);
				this.reportError(
					`[background-terminals] completion queue evicted ${oldest.value}; use bg_status to inspect it.`,
				);
			}
		}
		this.pending.set(snapshot.id, snapshot);
		if (this.context.isIdle()) Effect.runFork(this.flush);
	}
	enqueueNotification(notification: RunningTerminalNotification) {
		if (this.lifecycle === "closed" || !this.context) return;
		if (
			!this.notificationPending.has(notification.id) &&
			this.notificationPending.size === MAX_TRACKED
		) {
			const oldest = this.notificationPending.keys().next();
			if (!oldest.done) {
				this.notificationPending.delete(oldest.value);
				this.attempts.delete(oldest.value);
				this.markFailed(oldest.value);
				this.reportError(
					`[background-terminals] notification queue evicted ${oldest.value}.`,
				);
			}
		}
		this.notificationPending.set(notification.id, notification);
		if (this.context.isIdle()) Effect.runFork(this.flush);
	}
	terminalSettled(terminalId: string) {
		this.consume(
			[...this.notificationPending.values()]
				.filter((notification) => notification.terminalId === terminalId)
				.map((notification) => notification.id),
		);
	}
	consume(ids: readonly string[]) {
		for (const id of ids) {
			this.pending.delete(id);
			this.notificationPending.delete(id);
			this.attempts.delete(id);
			this.failed.delete(id);
		}
	}
	private notificationBatch():
		| { notifications: RunningTerminalNotification[]; content: string }
		| undefined {
		const notifications: RunningTerminalNotification[] = [];
		const parts = ["[Background terminal notifications]\n\n"];
		let bytes = Buffer.byteLength(parts[0]);
		for (const notification of this.notificationPending.values()) {
			if ((this.attempts.get(notification.id) ?? 0) >= MAX_DELIVERY_ATTEMPTS)
				continue;
			const rendered = formatTerminalNotification(notification);
			const separator = notifications.length ? "\n\n---\n\n" : "";
			const addedBytes =
				Buffer.byteLength(separator) + Buffer.byteLength(rendered);
			if (notifications.length && bytes + addedBytes > COMPLETION_BATCH_BYTES)
				break;
			parts.push(separator, rendered);
			bytes += addedBytes;
			notifications.push(notification);
		}
		return notifications.length
			? { notifications, content: parts.join("") }
			: undefined;
	}
	private batch():
		| { snapshots: SettledTerminalSnapshot[]; content: string }
		| undefined {
		const snapshots: SettledTerminalSnapshot[] = [];
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
		if (this.lifecycle === "closed") return;
		const generation = ++this.retryGeneration;
		Effect.runFork(
			Effect.sleep(
				RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)],
			).pipe(
				Effect.tap(() =>
					this.retryGeneration === generation && this.context?.isIdle()
						? this.flush
						: Effect.void,
				),
			),
		);
	}
	flush = Effect.sync(() => {
		if (
			this.flushState === "flushing" ||
			this.lifecycle === "closed" ||
			this.paused ||
			!this.context
		)
			return;
		this.retryGeneration++;
		this.flushState = "flushing";
		try {
			for (let sent = 0; sent < MAX_TRACKED; sent++) {
				const notificationBatch = this.notificationBatch();
				if (notificationBatch) {
					const ids = notificationBatch.notifications.map(
						(notification) => notification.id,
					);
					try {
						this.pi.sendMessage(
							{
								customType: "background-terminal-notification",
								content: notificationBatch.content,
								display: true,
								details: { ids },
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
						this.consume(ids);
					} catch (error) {
						let attempt = 0;
						for (const id of ids) {
							attempt = (this.attempts.get(id) ?? 0) + 1;
							this.attempts.set(id, attempt);
							if (attempt === MAX_DELIVERY_ATTEMPTS) this.markFailed(id);
						}
						if (attempt < MAX_DELIVERY_ATTEMPTS) this.scheduleRetry(attempt);
						else
							this.reportError(
								`[background-terminals] notification delivery failed for ${ids.join(", ")}: ${sanitizeInline(String(error).slice(0, 512))}`,
							);
						return;
					}
					continue;
				}
				const batch = this.batch();
				if (!batch) return;
				try {
					this.pi.sendMessage(
						{
							customType: "background-terminal-results",
							content: batch.content,
							display: true,
							details: {
								ids: batch.snapshots.map((snapshot) => snapshot.id),
							},
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
						this.reportError(
							`[background-terminals] completion delivery failed for ${batch.snapshots.map((snapshot) => snapshot.id).join(", ")}; use bg_status to inspect retained results: ${sanitizeInline(String(error).slice(0, 512))}`,
						);
					return;
				}
			}
		} finally {
			this.flushState = "idle";
		}
	});
	clear() {
		this.lifecycle = "closed";
		this.context = undefined;
		this.retryGeneration++;
		this.pending.clear();
		this.notificationPending.clear();
		this.attempts.clear();
		this.failed.clear();
		this.paused = false;
	}
}
