import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BackgroundTerminalManager,
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
  const sanitized = Buffer.from(sanitizeMultiline(text));
  let start = Math.max(0, sanitized.length - maxBytes);
  while (start < sanitized.length && (sanitized[start] & 0xc0) === 0x80)
    start++;
  return sanitized
    .subarray(start)
    .toString("utf8")
    .split("\n")
    .slice(-MAX_LINES)
    .join("\n");
}
function elapsed(snapshot: TerminalSnapshot): string {
  return `${Math.max(0, Math.round(((snapshot.settledAt ?? Date.now()) - snapshot.createdAt) / 1000))}s`;
}
function summary(snapshot: TerminalSnapshot): string {
  const exit =
    snapshot.state === "running"
      ? "running"
      : (snapshot.signal ??
        (snapshot.exitCode === undefined
          ? snapshot.state
          : `exit ${snapshot.exitCode}`));
  return `${sanitizeInline(snapshot.id)} [${snapshot.state}] ${sanitizeInline(snapshot.title)} · ${exit} · ${elapsed(snapshot)}`;
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
function formatTerminalReport(
  snapshot: TerminalSnapshot,
  outputBytes = MAX_TEXT,
): string {
  const sections = [summary(snapshot), `cwd: ${sanitizeInline(snapshot.cwd)}`];
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
    sections.push(
      "\nOnly bounded output tails are retained. Redirect output explicitly when durable or full logs matter.",
    );
  return sections.join("\n");
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
  clear() {
    this.closed = true;
    this.context = undefined;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.pending.clear();
    this.attempts.clear();
    this.failed.clear();
  }
}

export default function backgroundTerminals(pi: ExtensionAPI) {
  const delivery = new BackgroundTerminalDelivery(pi);
  let context: ExtensionContext | undefined;
  let lastStatus: string | undefined | null = null;
  let manager: BackgroundTerminalManager;
  const updateStatus = () => {
    if (!context?.hasUI) return;
    const running = manager
      .list()
      .filter((snapshot) => snapshot.state === "running").length;
    const status = running ? `${running} bg · /ps` : undefined;
    if (status === lastStatus) return;
    lastStatus = status;
    context.ui.setStatus("background-terminals", status);
  };
  const createManager = () =>
    new BackgroundTerminalManager((snapshot, consumed) => {
      updateStatus();
      if (consumed) delivery.consume([snapshot.id]);
      else if (
        snapshot.state !== "done" ||
        snapshot.stdout.totalBytes > 0 ||
        snapshot.stderr.totalBytes > 0 ||
        snapshot.error
      )
        delivery.enqueue(snapshot);
    });
  manager = createManager();
  const stopSession = async (keepContext: boolean) => {
    delivery.clear();
    if (context?.hasUI) {
      try {
        context.ui.setStatus("background-terminals", undefined);
      } catch {}
    }
    const stopped = manager;
    manager = createManager();
    lastStatus = null;
    if (!keepContext) context = undefined;
    await stopped.shutdown();
    if (context) delivery.setContext(context);
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    delivery.setContext(ctx);
    updateStatus();
  });
  pi.on("agent_end", async () => {
    if (context && !context.hasUI) await stopSession(true);
  });
  pi.on("agent_settled", () => delivery.flush());
  pi.on("session_shutdown", () => stopSession(false));

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
      "Never use for interactive commands. Do not overlap workspace-mutating commands with workspace=write delegates.",
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
        snapshot = manager.start({
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
      const snapshot = manager.get(params.id);
      if (!snapshot)
        throw new Error(`Unknown terminal id "${sanitizeInline(params.id)}".`);
      if (snapshot.state !== "running") delivery.consume([snapshot.id]);
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
      const entries = manager.list();
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
      const work = manager.kill(ids).catch((error) => {
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
      delivery.consume(ids);
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
  pi.registerCommand("ps", {
    description: "List tracked background terminals",
    handler: async (_args, ctx) => {
      const entries = manager.list();
      if (ctx.hasUI) ctx.ui.notify(listText(entries), "info");
    },
  });
}
