import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import { truncateUtf8Tail } from "../../lib/text.ts";
import {
	MAX_TRACKED,
	type SettledTerminalSnapshot,
	type TerminalMetadata,
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
function elapsed(snapshot: TerminalMetadata): string {
	const end =
		snapshot.state === "running"
			? Effect.runSync(Clock.currentTimeMillis)
			: snapshot.settledAt;
	return `${Math.max(0, Math.round((end - snapshot.createdAt) / 1000))}s`;
}
export function statusSummary(snapshot: TerminalMetadata): string {
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
export function summary(snapshot: TerminalMetadata): string {
	return `${sanitizeInline(snapshot.id)} ${statusSummary(snapshot)}`;
}
export function terminalMetadata(snapshot: TerminalMetadata) {
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

type DeliveryItem =
	| {
			kind: "completion";
			id: string;
			terminalId: string;
			snapshot: SettledTerminalSnapshot;
	  }
	| {
			kind: "notification";
			id: string;
			terminalId: string;
			notification: RunningTerminalNotification;
	  };

export class BackgroundTerminalDelivery {
	private context?: ExtensionContext;
	private readonly pending = new Map<string, DeliveryItem>();
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
	private queue(item: DeliveryItem) {
		if (this.lifecycle === "closed" || !this.context) return;
		const sameKind = [...this.pending.values()].filter(
			(pending) => pending.kind === item.kind,
		);
		if (!this.pending.has(item.id) && sameKind.length === MAX_TRACKED) {
			const [oldest] = sameKind;
			this.pending.delete(oldest.id);
			this.attempts.delete(oldest.id);
			this.markFailed(oldest.id);
			this.reportError(
				`[background-terminals] ${item.kind} queue evicted ${oldest.id}${item.kind === "completion" ? "; use bg_status to inspect it" : ""}.`,
			);
		}
		this.pending.set(item.id, item);
		if (this.context.isIdle()) Effect.runFork(this.flush);
	}
	enqueue(snapshot: SettledTerminalSnapshot) {
		this.queue({
			kind: "completion",
			id: snapshot.id,
			terminalId: snapshot.id,
			snapshot,
		});
	}
	enqueueNotification(notification: RunningTerminalNotification) {
		this.queue({
			kind: "notification",
			id: notification.id,
			terminalId: notification.terminalId,
			notification,
		});
	}
	terminalSettled(terminalId: string) {
		this.consume(
			[...this.pending.values()]
				.filter(
					(item) =>
						item.kind === "notification" && item.terminalId === terminalId,
				)
				.map((item) => item.id),
		);
	}
	consume(ids: readonly string[]) {
		for (const id of ids) {
			this.pending.delete(id);
			this.attempts.delete(id);
			this.failed.delete(id);
		}
	}
	private batch(kind: DeliveryItem["kind"]) {
		const items: DeliveryItem[] = [];
		const parts = [
			kind === "notification"
				? "[Background terminal notifications]\n\n"
				: "[Background terminal results]\n\n",
		];
		let bytes = Buffer.byteLength(parts[0]);
		for (const item of this.pending.values()) {
			if (
				item.kind !== kind ||
				(this.attempts.get(item.id) ?? 0) >= MAX_DELIVERY_ATTEMPTS
			)
				continue;
			let rendered =
				item.kind === "notification"
					? formatTerminalNotification(item.notification)
					: formatTerminalReport(item.snapshot, COMPLETION_TEXT_BYTES);
			const separator = items.length ? "\n\n---\n\n" : "";
			let addedBytes =
				Buffer.byteLength(separator) + Buffer.byteLength(rendered);
			if (items.length && bytes + addedBytes > COMPLETION_BATCH_BYTES) break;
			if (
				item.kind === "completion" &&
				bytes + addedBytes > COMPLETION_BATCH_BYTES
			) {
				rendered = `${summary(item.snapshot)}\nCompletion detail exceeded the delivery limit; use bg_status ${item.id}.`;
				addedBytes = Buffer.byteLength(rendered);
			}
			parts.push(separator, rendered);
			bytes += addedBytes;
			items.push(item);
		}
		return items.length ? { kind, items, content: parts.join("") } : undefined;
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
			for (let sent = 0; sent < MAX_TRACKED * 2; sent++) {
				const batch = this.batch("notification") ?? this.batch("completion");
				if (!batch) return;
				const ids = batch.items.map((item) => item.id);
				try {
					this.pi.sendMessage(
						{
							customType: `background-terminal-${batch.kind === "notification" ? "notification" : "results"}`,
							content: batch.content,
							display: true,
							details: { ids },
						},
						{
							deliverAs: "followUp",
							triggerTurn:
								batch.kind === "notification" ||
								batch.items.some(
									(item) =>
										item.kind === "completion" &&
										item.snapshot.state !== "done",
								),
						},
					);
					this.consume(ids);
				} catch (error) {
					const retryable: number[] = [];
					const exhausted: string[] = [];
					for (const id of ids) {
						const attempt = (this.attempts.get(id) ?? 0) + 1;
						this.attempts.set(id, attempt);
						if (attempt < MAX_DELIVERY_ATTEMPTS) retryable.push(attempt);
						else {
							this.markFailed(id);
							exhausted.push(id);
						}
					}
					if (retryable.length) this.scheduleRetry(Math.max(...retryable));
					if (exhausted.length)
						this.reportError(
							`[background-terminals] ${batch.kind} delivery failed for ${exhausted.join(", ")}${batch.kind === "completion" ? "; use bg_status to inspect retained results" : ""}: ${sanitizeInline(String(error).slice(0, 512))}`,
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
		this.attempts.clear();
		this.failed.clear();
		this.paused = false;
	}
}
