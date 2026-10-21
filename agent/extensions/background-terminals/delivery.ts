import { type Static, Type } from "@earendil-works/pi-ai";
import type {
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect } from "effect";
import { sanitizeInline, sanitizeMultiline, truncateUtf8Tail } from "../../lib/text.ts";
import {
  type SettledTerminalSnapshot,
  type TerminalMetadata,
  type TerminalSnapshot,
  terminalResultFields,
} from "./manager.ts";
import type { RunningTerminalNotification } from "./notifications.ts";
import {
  elapsedMs,
  formatDuration,
  type NotificationView,
  notificationView,
  type TerminalView,
  terminalView,
} from "./render.ts";

export const RESULTS_MESSAGE = "background-terminal-results";

export const NOTIFICATION_MESSAGE = "background-terminal-notification";

// emit-to-pi notifications are unbounded per terminal, so each delivery queue is bounded.
export const MAX_QUEUED_PER_KIND = 32;

const MAX_LINES = 80;

const MAX_TEXT = 24 * 1024;

const COMPLETION_OUTPUT_BYTES = 24 * 1024;

const COMPLETION_BATCH_BYTES = 256 * 1024;

const BATCH_HEADERS = {
  notification: "[Background terminal notifications]\n\n",
  completion: "[Background terminal results]\n\n",
} as const;

const logError = (message: string) => Effect.runSync(Effect.logError(message));

export function sanitizeErrorForDisplay(error: Error | string): Error {
  const message = error instanceof Error ? error.message : error;

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

export function statusSummary(snapshot: TerminalMetadata): string {
  const fields = terminalResultFields(snapshot);

  const exit =
    snapshot.state === "running"
      ? "running"
      : (fields.signal ??
        (fields.exitCode === undefined ? snapshot.state : `exit ${fields.exitCode}`));

  return `[${snapshot.state}] ${sanitizeInline(snapshot.title)} · ${exit} · ${formatDuration(elapsedMs(snapshot))}`;
}

export function summary(snapshot: TerminalMetadata): string {
  return `${sanitizeInline(snapshot.id)} ${statusSummary(snapshot)}`;
}

export const terminalStateSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("killed"),
]);

export const terminalMetadataSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  cwd: Type.String(),
  pid: Type.Union([Type.Number(), Type.Null()]),
  state: terminalStateSchema,
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  stdoutBytes: Type.Number(),
  stderrBytes: Type.Number(),
});

// Tool details and codemode's structured results share this shape, so absent
// values are JSON nulls rather than undefined keys.
export function terminalMetadata(
  snapshot: TerminalMetadata,
): Static<typeof terminalMetadataSchema> {
  const fields = terminalResultFields(snapshot);

  return {
    id: sanitizeInline(snapshot.id),
    title: sanitizeInline(snapshot.title),
    cwd: sanitizeInline(snapshot.cwd),
    pid: snapshot.pid ?? null,
    state: snapshot.state,
    exitCode: fields.exitCode ?? null,
    signal: fields.signal ?? null,
    stdoutBytes: snapshot.stdout.totalBytes,
    stderrBytes: snapshot.stderr.totalBytes,
  };
}

function formatTerminalOutput(snapshot: TerminalSnapshot, outputBytes: number) {
  const stdout = sanitizeMultiline(snapshot.stdout.text);
  const stderr = sanitizeMultiline(snapshot.stderr.text);

  // Reserve up to half the budget for stderr; give unused space to stdout.
  const stdoutBudget = Math.max(
    Math.floor(outputBytes / 2),
    outputBytes - Buffer.byteLength(stderr),
  );

  const displayedStdout = truncateUtf8Tail(stdout, stdoutBudget);

  const displayedStderr = truncateUtf8Tail(
    stderr,
    outputBytes - Buffer.byteLength(displayedStdout),
  );

  const sections: string[] = [];
  let abbreviated = false;

  for (const [name, output, text, displayed] of [
    ["stdout", snapshot.stdout, stdout, displayedStdout],
    ["stderr", snapshot.stderr, stderr, displayedStderr],
  ] as const) {
    if (output.totalBytes === 0) continue;

    const discarded =
      output.truncatedBytes > 0
        ? ` (${output.truncatedBytes} earlier bytes discarded by retention)`
        : "";

    sections.push(`\n${name}${discarded}:\n${displayed}`);

    const omitted = Buffer.byteLength(text) - Buffer.byteLength(displayed);

    if (omitted > 0) {
      abbreviated = true;
      sections.push(`${name} display abbreviated: ${omitted} retained bytes not shown.`);
    }
  }

  const error = terminalResultFields(snapshot).error;

  if (error) sections.push(`\nerror: ${sanitizeInline(error)}`);

  return { text: sections.join("\n"), abbreviated };
}

export function formatTerminalDetails(snapshot: TerminalSnapshot): string {
  return [
    `command: ${sanitizeInline(snapshot.command)}`,
    `cwd: ${sanitizeInline(snapshot.cwd)}`,
    formatTerminalOutput(snapshot, MAX_TEXT * 2).text,
  ].join("\n");
}

export function formatTerminalReport(snapshot: TerminalSnapshot): string {
  return `${summary(snapshot)}\n${formatTerminalDetails(snapshot)}`;
}

export function formatEndedTerminalNotifications(
  notifications: readonly RunningTerminalNotification[],
): string {
  return `notifications sent before it ended:\n${notifications.map((notification) => tail(notification.message)).join("\n---\n")}`;
}

function formatTerminalCompletion(
  snapshot: SettledTerminalSnapshot,
  notifications: readonly RunningTerminalNotification[],
): string {
  const output = formatTerminalOutput(snapshot, COMPLETION_OUTPUT_BYTES);
  const sections = [summary(snapshot)];

  if (notifications.length) sections.push(formatEndedTerminalNotifications(notifications));
  sections.push(output.text);

  if (output.abbreviated)
    sections.push(`\nUse bg_status ${sanitizeInline(snapshot.id)} for more retained output.`);

  return sections.join("\n");
}

function formatTerminalNotification(notification: RunningTerminalNotification): string {
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

interface DeliveryBatch {
  customType: string;
  content: string;
  details:
    | { ids: string[]; terminals: TerminalView[]; notifications: NotificationView[] }
    | { ids: string[]; notifications: NotificationView[] };
}

export class BackgroundTerminalDelivery {
  private context?: ExtensionContext;
  private readonly pending = new Map<string, DeliveryItem>();
  // Items evicted from a full queue, kept so bg_list can report what was never delivered.
  private readonly failed = new Map<string, DeliveryItem["terminalId"]>();
  private flushState: "idle" | "flushing" = "idle";
  private settleWaiter?: () => void;
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

    const terminals = new Set(this.failed.values());

    return `Automatic background-terminal delivery dropped ${[...this.failed.keys()].join(", ")} from a full queue. Inspect ${[...terminals].join(", ")} with bg_status, which clears this notice.`;
  }
  clearDropped(terminalId: string) {
    for (const [id, droppedTerminalId] of this.failed)
      if (droppedTerminalId === terminalId) this.failed.delete(id);
  }
  setContext(context: ExtensionContext) {
    this.context = context;
  }
  private markFailed(item: DeliveryItem) {
    this.pending.delete(item.id);
    this.failed.set(item.id, item.terminalId);

    if (this.failed.size <= MAX_QUEUED_PER_KIND) return;
    const oldest = this.failed.keys().next();

    if (!oldest.done) this.failed.delete(oldest.value);
  }
  private queue(item: DeliveryItem) {
    if (!this.context || this.failed.has(item.id)) return;

    const sameKind = [...this.pending.values()].filter((pending) => pending.kind === item.kind);

    if (!this.pending.has(item.id) && sameKind.length === MAX_QUEUED_PER_KIND) {
      const [oldest] = sameKind;
      this.markFailed(oldest);
      this.reportError(
        `[background-terminals] ${item.kind} queue evicted ${oldest.id}${item.kind === "completion" ? "; use bg_status to inspect it" : ""}.`,
      );
    }

    this.pending.set(item.id, item);

    // The settle wait returns pending items as its own entries, so steering them too would deliver them twice.
    if (this.settleWaiter) {
      this.settleWaiter();

      return;
    }

    // A notification waits for the run to settle, so a terminal that ends first carries it in its completion instead of steering a message of its own.
    if (item.kind === "completion" || this.context.isIdle())
      // The forked flush has no caller to receive its failure, so it reports here.
      Effect.runFork(
        this.flush.pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              this.reportError(`[background-terminals] delivery failed: ${Cause.pretty(cause)}`),
            ),
          ),
        ),
      );
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
  private pendingNotifications(terminalId: string): RunningTerminalNotification[] {
    return [...this.pending.values()].flatMap((item) =>
      item.kind === "notification" && item.terminalId === terminalId ? [item.notification] : [],
    );
  }
  // Notifications that do not fit with their completion stay in the notification batch, which drain sends first.
  private carriedNotifications(snapshot: SettledTerminalSnapshot): RunningTerminalNotification[] {
    const notifications = this.pendingNotifications(snapshot.id);

    if (!notifications.length) return notifications;

    const aloneBytes =
      Buffer.byteLength(BATCH_HEADERS.completion) +
      Buffer.byteLength(formatTerminalCompletion(snapshot, notifications));

    return aloneBytes <= COMPLETION_BATCH_BYTES ? notifications : [];
  }
  takeNotifications(terminalId: string): RunningTerminalNotification[] {
    const notifications = this.pendingNotifications(terminalId);

    for (const notification of notifications) this.pending.delete(notification.id);

    return notifications;
  }
  waitForDelivery(timeoutMs: number, signal: AbortSignal | undefined): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.pending.size > 0) return Effect.void;

      return Effect.callback<void>((resume) => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          resume(Effect.void);
        };

        this.settleWaiter = done;
        signal?.addEventListener("abort", done, { once: true });

        return Effect.sync(() => signal?.removeEventListener("abort", done));
      }).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.ensuring(
          Effect.sync(() => {
            this.settleWaiter = undefined;
          }),
        ),
        Effect.asVoid,
      );
    });
  }
  takePending(): CustomMessageEntryDraft[] {
    const entries: CustomMessageEntryDraft[] = [];

    this.drain((batch) => {
      entries.push({
        type: "custom_message",
        customType: batch.customType,
        content: batch.content,
        display: true,
        details: batch.details,
      });
    });

    return entries;
  }
  consume(ids: readonly string[]) {
    for (const id of ids) this.pending.delete(id);
  }
  private batch(kind: DeliveryItem["kind"]): DeliveryBatch | undefined {
    const ids: string[] = [];
    const terminals: TerminalView[] = [];
    const notifications: NotificationView[] = [];

    const parts: string[] = [BATCH_HEADERS[kind]];

    let bytes = Buffer.byteLength(parts[0]);

    const carriedIds = new Set(
      [...this.pending.values()].flatMap((item) =>
        item.kind === "completion"
          ? this.carriedNotifications(item.snapshot).map((notification) => notification.id)
          : [],
      ),
    );

    for (const item of this.pending.values()) {
      if (item.kind !== kind) continue;

      if (item.kind === "notification" && carriedIds.has(item.id)) continue;

      const carried = item.kind === "completion" ? this.carriedNotifications(item.snapshot) : [];

      let rendered =
        item.kind === "notification"
          ? formatTerminalNotification(item.notification)
          : formatTerminalCompletion(item.snapshot, carried);

      const separator = ids.length ? "\n\n---\n\n" : "";

      let addedBytes = Buffer.byteLength(separator) + Buffer.byteLength(rendered);

      if (ids.length && bytes + addedBytes > COMPLETION_BATCH_BYTES) break;

      if (item.kind === "completion" && bytes + addedBytes > COMPLETION_BATCH_BYTES) {
        rendered = `${summary(item.snapshot)}\nCompletion detail exceeded the delivery limit; use bg_status ${item.id}.`;
        addedBytes = Buffer.byteLength(rendered);
      }

      parts.push(separator, rendered);
      bytes += addedBytes;
      ids.push(item.id, ...carried.map((notification) => notification.id));
      notifications.push(...carried.map((notification) => notificationView(notification)));

      if (item.kind === "completion") terminals.push(terminalView(item.snapshot));
      else notifications.push(notificationView(item.notification));
    }

    if (!ids.length) return undefined;
    const content = parts.join("");

    if (kind === "completion")
      return {
        customType: RESULTS_MESSAGE,
        content,
        details: { ids, terminals, notifications },
      };

    return {
      customType: NOTIFICATION_MESSAGE,
      content,
      details: { ids, notifications },
    };
  }
  private drain(deliver: (batch: DeliveryBatch) => void) {
    for (let sent = 0; sent < MAX_QUEUED_PER_KIND * 2; sent++) {
      const batch = this.batch("notification") ?? this.batch("completion");

      if (!batch) return;
      deliver(batch);
      this.consume(batch.details.ids);
    }
  }
  flush = Effect.sync(() => {
    if (this.flushState === "flushing" || !this.context) return;
    this.flushState = "flushing";

    try {
      this.drain((batch) => {
        // Pi queues the message and reports asynchronous delivery failures itself. A
        // synchronous failure propagates and leaves the batch pending for the next flush.
        this.pi.sendMessage(
          {
            customType: batch.customType,
            content: batch.content,
            display: true,
            details: batch.details,
          },
          {
            deliverAs: "steer",
            triggerTurn: true,
          },
        );
      });
    } finally {
      this.flushState = "idle";
    }
  });
  clear() {
    this.context = undefined;
    this.pending.clear();
    this.failed.clear();
  }
}
