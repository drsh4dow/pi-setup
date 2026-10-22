import type { AttentionId, AttentionKind } from "./monitor-state.ts";
import type { WatchClock } from "./policy.ts";
import { renderPretty } from "./render.ts";
import type * as T from "./types.ts";

export interface AttentionPreview {
  readonly id: AttentionId;
  readonly pr: T.PrNumber;
  readonly kind: AttentionKind;
  readonly excerpt: string;
}
export interface AttentionBatchRef {
  readonly path: string;
  readonly sha256: string;
  readonly count: number;
  readonly preview: readonly AttentionPreview[];
}
export type MonitorCondition =
  | "pending-checks"
  | "merge-ready"
  | "blocked"
  | "awaiting-human"
  | "status-unavailable";
export type FinishedResult =
  | {
      readonly kind: "all-merged";
      readonly merged: T.NonEmpty<T.MergedPr>;
    }
  | {
      readonly kind: "closed";
      readonly closed: T.NonEmpty<T.PrContext>;
      readonly merged: readonly T.MergedPr[];
      readonly stillOpen: readonly T.PrContext[];
    };

interface Envelope {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly observedAt: string;
  readonly mode: T.WatchMode;
}
export type MonitorVerdict =
  | Extract<T.ProgressVerdict, { readonly kind: "RETRY" }>
  | Extract<T.BlockerVerdict, { readonly exitCode: 7 }>
  | (Envelope & {
      readonly kind: "MONITORING";
      readonly terminal: false;
      readonly frontier: T.PrContext;
      readonly condition: MonitorCondition;
    })
  | (Envelope & {
      readonly kind: "MONITOR_TIMEOUT";
      readonly terminal: true;
      readonly exitCode: 5;
      readonly scope: T.NonEmpty<T.PrContext>;
      readonly frontier: T.PrContext;
    })
  | (Envelope & {
      readonly kind: "ATTENTION";
      readonly terminal: true;
      readonly exitCode: 8;
      readonly batch: AttentionBatchRef;
    })
  | (Envelope & {
      readonly kind: "FINISHED";
      readonly terminal: true;
      readonly exitCode: 0;
      readonly result: FinishedResult;
    });
export type MonitorTerminalVerdict = Extract<
  MonitorVerdict,
  { readonly terminal: true }
>;
type Payload<V> = V extends unknown ? Omit<V, keyof Envelope> : never;
export type MonitorStamp = <const P extends Payload<MonitorVerdict>>(
  payload: P
) => Envelope & P;

export function monitorStamp(
  clock: WatchClock,
  mode: T.WatchMode
): MonitorStamp {
  let sequence = 0;
  return (payload) => ({
    schemaVersion: 1,
    sequence: (sequence += 1),
    observedAt: clock.observedAt(),
    mode,
    ...payload,
  });
}

function prList(prs: readonly T.PrContext[]): string {
  if (prs.length === 0) return "none";
  return prs.map((pr) => `#${pr.number}`).join(",");
}
function renderAttention(batch: AttentionBatchRef): string {
  const noun = batch.count === 1 ? "item" : "items";
  const lines = [
    `ATTENTION: ${batch.count} ${noun} need action`,
    `batch=${batch.path}`,
    `sha256=${batch.sha256}`,
    ...batch.preview.map(
      (item) => `${item.id} #${item.pr} ${item.kind} ${item.excerpt}`
    ),
  ];
  if (batch.count > batch.preview.length)
    lines.push(`(${batch.count - batch.preview.length} more in the batch file)`);
  return `${lines.join("\n")}\n`;
}
function renderFinished(result: FinishedResult): string {
  if (result.kind === "all-merged")
    return `FINISHED: all merged (${prList(result.merged.map((pr) => pr.context))})\n`;
  return `FINISHED: closed without merge ${prList(result.closed)}; merged ${prList(result.merged.map((pr) => pr.context))}; still open ${prList(result.stillOpen)}\n`;
}

export function renderMonitor(verdict: MonitorVerdict, pretty: boolean): string {
  if (!pretty) return `${JSON.stringify(verdict)}\n`;
  switch (verdict.kind) {
    case "RETRY":
    case "BLOCKER":
      return renderPretty(verdict);
    case "MONITORING":
      return `MONITORING: frontier=#${verdict.frontier.number}; condition=${verdict.condition}\n`;
    case "MONITOR_TIMEOUT":
      return `MONITOR_TIMEOUT: still monitoring frontier=#${verdict.frontier.number}; rearm with the same --state\n`;
    case "ATTENTION":
      return renderAttention(verdict.batch);
    case "FINISHED":
      return renderFinished(verdict.result);
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}
