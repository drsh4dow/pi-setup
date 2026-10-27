import { InvalidArgumentError } from "commander";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CliRuntime } from "./cli.ts";
import type {
  FeedbackReader,
  FeedbackSnapshot,
  SubmittedReviewState,
} from "./feedback.ts";
import {
  WatcherQueryError,
  discoverStack,
  resolveChecks,
  resolveContext,
} from "./github.ts";
import {
  type AttentionId,
  CONDITION_KINDS,
  type ConditionKind,
  type FinalRead,
  LANES,
  type Ledger,
  type Lifecycle,
  MonitorStateError,
  type MonitorLane,
  type PrLedger,
  type StateLock,
  type StoredItem,
  isAttentionId,
  loadLedger,
  lockState,
  newPrLedger,
  saveLedger,
  statePath,
  unlockState,
  writeBatch,
} from "./monitor-state.ts";
import {
  type FinishedResult,
  type MonitorCondition,
  type MonitorStamp,
  type MonitorTerminalVerdict,
  type MonitorVerdict,
  monitorStamp,
  renderMonitor,
} from "./monitor-verdict.ts";
import {
  classifyCi,
  isCiClear,
  mergeAssessment,
  queryBackoffSeconds,
  readyContribution,
  type WatchClock,
} from "./policy.ts";
import type * as T from "./types.ts";
import { nonEmpty } from "./types.ts";

const PROTOCOL_VERSION = 1;
const PREVIEW_LIMIT = 20;
const EXCERPT_LIMIT = 200;
const REPLY_MARKER = /^<!-- pi-event:([0-9a-f]{64}) -->$/;
/** Ends a babysitter's PR reply that acts on no item of this watch. */
const OWN_REPLY_MARKER = /^<!-- pi-event:reply -->$/;

interface Environment {
  readonly repository: T.Repository;
  readonly observedAt: string;
  readonly allowDraft: boolean;
}
interface PrStep {
  pr: PrLedger;
  readonly queued: StoredItem[];
  readonly acknowledged: Set<AttentionId>;
}
type ConditionBlocker = Extract<
  T.MergeBlocker,
  { readonly kind: ConditionKind }
>;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
function attentionId(
  repository: T.Repository,
  parts: readonly (string | number | boolean | null)[]
): AttentionId {
  const id = sha256(
    JSON.stringify([
      PROTOCOL_VERSION,
      `${repository.owner}/${repository.repo}`,
      ...parts,
    ])
  );
  if (!isAttentionId(id)) throw new Error(`sha256 produced ${id}`);
  return id;
}
const excerpt = (value: string): string =>
  value.replace(/\s+/g, " ").trim().slice(0, EXCERPT_LIMIT);

function memberLedger(ledger: Ledger, number: T.PrNumber): PrLedger {
  const found = ledger.prs.find((pr) => pr.number === number);
  if (found === undefined) throw new Error(`no ledger entry for #${number}`);
  return found;
}

function updateMember(
  ledger: Ledger,
  number: T.PrNumber,
  change: (step: PrStep) => void
): Ledger {
  const step: PrStep = {
    pr: memberLedger(ledger, number),
    queued: [],
    acknowledged: new Set(),
  };
  change(step);
  const known = new Set(ledger.items.map((item) => item.id));
  const items = ledger.items.map((item) =>
    step.acknowledged.has(item.id) ? { ...item, acknowledged: true } : item
  );
  for (const item of step.queued)
    if (!known.has(item.id)) {
      known.add(item.id);
      items.push(item);
    }
  return {
    ...ledger,
    prs: ledger.prs.map((pr) => (pr.number === number ? step.pr : pr)),
    items,
  };
}

function queue(
  step: PrStep,
  environment: Environment,
  item: Pick<StoredItem, "id" | "kind" | "excerpt" | "detail"> &
    Partial<Pick<StoredItem, "held">>
): void {
  step.queued.push({
    ...item,
    excerpt: excerpt(item.excerpt),
    pr: step.pr.number,
    acknowledged: false,
    held: item.held ?? false,
    observedAt: environment.observedAt,
  });
}

function recoverLane(
  step: PrStep,
  lane: MonitorLane,
  environment: Environment
): void {
  const outage = step.pr.outages[lane];
  if (!outage.active) return;
  step.pr = {
    ...step.pr,
    outages: { ...step.pr.outages, [lane]: { ...outage, active: false } },
  };
  queue(step, environment, {
    id: attentionId(environment.repository, [
      step.pr.number,
      "status-recovered",
      lane,
      outage.generation,
    ]),
    kind: "status-recovered",
    excerpt: `${lane} reads for #${step.pr.number} work again`,
    detail: { lane, outageGeneration: outage.generation },
  });
}

function owesFinalRead(pr: PrLedger): boolean {
  return (
    (pr.lifecycle.kind === "merged" || pr.lifecycle.kind === "closed") &&
    pr.lifecycle.finalRead === "owed"
  );
}

function finishFinalRead(step: PrStep): void {
  const lifecycle = step.pr.lifecycle;
  if (lifecycle.kind === "merged" || lifecycle.kind === "closed")
    step.pr = { ...step.pr, lifecycle: { ...lifecycle, finalRead: "done" } };
}

/**
 * Reports a lane that gave up. An outage already reported stays silent, except
 * for a failed final read: it is the member's last read, so the agent hears of
 * it even when it acknowledged the outage that was already running, and the
 * item that says so settles the final read.
 */
function markLaneUnavailable(
  step: PrStep,
  lane: MonitorLane,
  failure: T.QueryFailure,
  environment: Environment,
  finalRead: boolean
): void {
  const outage = step.pr.outages[lane];
  if (outage.active && !finalRead) return;
  const generation = outage.generation + 1;
  step.pr = {
    ...step.pr,
    outages: { ...step.pr.outages, [lane]: { active: true, generation } },
  };
  queue(step, environment, {
    id: attentionId(environment.repository, [
      step.pr.number,
      "status-unavailable",
      lane,
      generation,
    ]),
    kind: "status-unavailable",
    excerpt: finalRead
      ? `the final ${lane} read for #${step.pr.number} failed, so comments since the last read are unread: ${failure.detail}`
      : `${lane} reads for #${step.pr.number} keep failing: ${failure.detail}`,
    detail: { lane, outageGeneration: generation, failure, finalRead },
  });
  if (finalRead) finishFinalRead(step);
}

interface Revision {
  readonly subject: "review" | "comment" | "thread-comment";
  readonly nodeId: string;
  readonly authorLogin: string | null;
  readonly authorIsBot: boolean;
  readonly body: string;
  readonly updatedAt: string;
  readonly reviewState: SubmittedReviewState | null;
  readonly inResolvedThread: boolean;
  readonly detail: Record<string, unknown>;
}
function revisions(snapshot: FeedbackSnapshot): readonly Revision[] {
  const all: Revision[] = [];
  for (const review of snapshot.reviews)
    all.push({
      subject: "review",
      nodeId: review.id,
      authorLogin: review.authorLogin,
      authorIsBot: review.authorIsBot,
      body: review.body,
      updatedAt: review.updatedAt,
      reviewState: review.state,
      inResolvedThread: false,
      detail: { subject: "review", ...review },
    });
  for (const comment of snapshot.comments)
    all.push({
      subject: "comment",
      nodeId: comment.id,
      authorLogin: comment.authorLogin,
      authorIsBot: comment.authorIsBot,
      body: comment.body,
      updatedAt: comment.updatedAt,
      reviewState: null,
      inResolvedThread: false,
      detail: { subject: "comment", ...comment },
    });
  for (const thread of snapshot.threads)
    for (const comment of thread.comments)
      all.push({
        subject: "thread-comment",
        nodeId: comment.id,
        authorLogin: comment.authorLogin,
        authorIsBot: comment.authorIsBot,
        body: comment.body,
        updatedAt: comment.updatedAt,
        reviewState: null,
        inResolvedThread: thread.isResolved,
        detail: {
          subject: "thread-comment",
          threadId: thread.id,
          threadResolved: thread.isResolved,
          ...comment,
        },
      });
  return all;
}

function trailingReplyMarkers(body: string): {
  readonly ownReply: boolean;
  readonly acks: readonly AttentionId[];
} {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  let ownReply = false;
  const acks: AttentionId[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (OWN_REPLY_MARKER.test(line)) {
      ownReply = true;
      continue;
    }
    const id = REPLY_MARKER.exec(line)?.[1];
    if (id === undefined || !isAttentionId(id)) break;
    acks.push(id);
  }
  return { ownReply, acks };
}

function observeFeedback(
  step: PrStep,
  snapshot: FeedbackSnapshot,
  deliveredFeedback: ReadonlySet<AttentionId>,
  environment: Environment
): void {
  const seen = new Set(step.pr.seenRevisions);
  for (const revision of revisions(snapshot)) {
    if (revision.authorLogin === snapshot.viewerLogin) {
      const markers = trailingReplyMarkers(revision.body);
      if (markers.ownReply || markers.acks.length > 0) {
        for (const id of markers.acks)
          if (deliveredFeedback.has(id)) step.acknowledged.add(id);
        continue;
      }
    }
    // An empty COMMENTED review only wraps inline comments, which arrive as thread comments.
    if (revision.reviewState === "COMMENTED" && revision.body.trim() === "")
      continue;
    const id = attentionId(environment.repository, [
      step.pr.number,
      revision.subject,
      revision.nodeId,
      revision.updatedAt,
      revision.reviewState,
      sha256(revision.body),
    ]);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!step.pr.feedbackBaselined && revision.inResolvedThread) continue;
    const state = revision.reviewState === null ? "" : ` ${revision.reviewState}`;
    queue(step, environment, {
      id,
      kind: "feedback",
      excerpt: `${revision.subject}${state} by ${revision.authorLogin ?? "ghost"}: ${revision.body}`,
      detail: revision.detail,
      held: revision.inResolvedThread && revision.authorIsBot,
    });
  }
  step.pr = { ...step.pr, feedbackBaselined: true, seenRevisions: [...seen] };
}

function deliveredFeedback(
  ledger: Ledger,
  number: T.PrNumber
): ReadonlySet<AttentionId> {
  return new Set(
    ledger.items.flatMap((item) =>
      item.pr === number && item.kind === "feedback" && !item.acknowledged
        ? [item.id]
        : []
    )
  );
}

function blockerFacts(blocker: ConditionBlocker): readonly string[] {
  switch (blocker.kind) {
    case "merge-conflicts":
      return [blocker.facts.mergeable, blocker.facts.mergeStateStatus];
    case "failing-checks":
      if (blocker.ci.kind === "ci-github-rejected")
        return [
          "github-rejected",
          blocker.ci.github.mergeStateStatus,
          blocker.ci.github.headRollupState,
        ];
      return blocker.ci.failed
        .map((check) => `${check.name}\u0000${check.reportedState}\u0000${check.link}`)
        .sort();
    case "merge-gate":
      return [blocker.reason];
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}

function setCondition(
  step: PrStep,
  environment: Environment,
  kind: ConditionKind,
  head: string | null,
  blocker: ConditionBlocker | null
): void {
  const previous = step.pr.conditions[kind];
  const generation =
    blocker === null || previous.active
      ? previous.generation
      : previous.generation + 1;
  step.pr = {
    ...step.pr,
    conditions: {
      ...step.pr.conditions,
      [kind]: { active: blocker !== null, generation },
    },
  };
  if (blocker === null) return;
  const facts = blockerFacts(blocker);
  queue(step, environment, {
    id: attentionId(environment.repository, [
      step.pr.number,
      "merge-blocker",
      kind,
      generation,
      head,
      ...facts,
    ]),
    kind: "merge-blocker",
    excerpt: `${kind} on #${step.pr.number}: ${facts.map((fact) => fact.split("\u0000").join(" ")).join("; ")}`,
    detail: { head, blocker },
  });
}

/** GitHub reports UNKNOWN while it recomputes mergeability, which is no evidence either way. */
function mergeability(
  facts: T.PullRequestFacts
): "conflicting" | "mergeable" | "unknown" {
  if (facts.mergeable === "UNKNOWN" || facts.mergeStateStatus === "UNKNOWN")
    return "unknown";
  if (
    facts.mergeable === "CONFLICTING" ||
    facts.mergeStateStatus === "DIRTY" ||
    facts.mergeStateStatus === "CONFLICTING"
  )
    return "conflicting";
  return "mergeable";
}

function gateReason(
  facts: T.PullRequestFacts,
  allowDraft: boolean
): T.MergeGateReason | null {
  if (facts.isDraft && !allowDraft) return "draft-pr";
  if (facts.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  return null;
}

const isMerged = (facts: T.PullRequestFacts): boolean =>
  facts.state === "MERGED" || facts.mergedAt !== null;

/**
 * A member seen merged or closed for the first time owes one last feedback
 * read, so that a comment posted since the previous poll, or before the first
 * one, is delivered. A member already ended keeps its final read's progress.
 */
function lifecycleOf(facts: T.PullRequestFacts, previous: Lifecycle): Lifecycle {
  const finalRead: FinalRead =
    previous.kind === "merged" || previous.kind === "closed"
      ? previous.finalRead
      : "owed";
  if (isMerged(facts))
    return { kind: "merged", mergedAt: facts.mergedAt, finalRead };
  if (facts.state === "CLOSED") return { kind: "closed", finalRead };
  return { kind: "open" };
}

function observeLifecycle(
  step: PrStep,
  facts: T.PullRequestFacts,
  environment: Environment
): void {
  step.pr = { ...step.pr, lifecycle: lifecycleOf(facts, step.pr.lifecycle) };
  if (step.pr.lifecycle.kind !== "open") return;
  const head = facts.headRefOid;
  const merge = mergeability(facts);
  if (merge === "conflicting")
    setCondition(step, environment, "merge-conflicts", head, {
      kind: "merge-conflicts",
      pr: facts.context,
      facts,
    });
  else if (merge === "mergeable")
    setCondition(step, environment, "merge-conflicts", head, null);
  const reason = gateReason(facts, environment.allowDraft);
  setCondition(
    step,
    environment,
    "merge-gate",
    head,
    reason === null ? null : { kind: "merge-gate", pr: facts.context, reason }
  );
}

async function readCi(
  reader: T.GitHubReader,
  facts: T.PullRequestFacts
): Promise<T.CiState> {
  const checks = await resolveChecks(reader, facts.context);
  return classifyCi(checks, await mergeAssessment(reader, facts));
}

function observeCi(
  step: PrStep,
  ci: T.CiState,
  facts: T.PullRequestFacts,
  environment: Environment
): void {
  const head = facts.headRefOid;
  if (ci.kind === "ci-failing" || ci.kind === "ci-github-rejected")
    setCondition(step, environment, "failing-checks", head, {
      kind: "failing-checks",
      pr: facts.context,
      ci,
    });
  else setCondition(step, environment, "failing-checks", head, null);
  if (isCiClear(ci) && step.pr.ciRecoveryOwed) {
    queue(step, environment, {
      id: attentionId(environment.repository, [
        step.pr.number,
        "ci-recovered",
        step.pr.conditions["failing-checks"].generation,
      ]),
      kind: "ci-recovered",
      excerpt: `CI on #${step.pr.number} is clean again at ${head ?? "unknown head"}`,
      detail: { head, checks: ci.kind === "ci-clean" ? ci.all : [] },
    });
    step.pr = { ...step.pr, ciRecoveryOwed: false };
  }
  if (step.pr.conditions["failing-checks"].active)
    step.pr = { ...step.pr, ciRecoveryOwed: true };
}

function mergeReadyProof(
  facts: T.PullRequestFacts,
  ci: T.CiState,
  feedback: FeedbackSnapshot,
  allowDraft: boolean
): T.ReadyPr | null {
  if (!isCiClear(ci) || mergeability(facts) !== "mergeable") return null;
  if (feedback.threads.some((thread) => !thread.isResolved)) return null;
  const ready = readyContribution(
    {
      kind: "open",
      context: facts.context,
      facts,
      threads: [],
      ci,
      reviewAutomationRunning: false,
    },
    allowDraft
  );
  return ready?.kind === "ready-pr" ? ready : null;
}

function queueMergeReady(
  step: PrStep,
  environment: Environment,
  head: string | null,
  ready: T.ReadyPr
): void {
  queue(step, environment, {
    id: attentionId(environment.repository, [
      step.pr.number,
      "merge-ready",
      head,
    ]),
    kind: "merge-ready",
    excerpt: `#${step.pr.number} is merge-ready at ${head ?? "unknown head"} (reviewDecision=${ready.proof.gate.reviewDecision ?? "none"}); merging stays with the operator`,
    detail: { head, proof: ready.proof },
  });
}

function acknowledge(
  ledger: Ledger,
  ids: readonly AttentionId[]
): { readonly ledger: Ledger; readonly unknown: readonly AttentionId[] } {
  const known = new Set(ledger.items.map((item) => item.id));
  const acked = new Set(ids);
  return {
    ledger: {
      ...ledger,
      items: ledger.items.map((item) =>
        acked.has(item.id) && !item.acknowledged
          ? { ...item, acknowledged: true }
          : item
      ),
    },
    unknown: ids.filter((id) => !known.has(id)),
  };
}

type ScopeStatus =
  | { readonly kind: "finished"; readonly result: FinishedResult }
  | { readonly kind: "open"; readonly frontier: T.PrContext };
/**
 * A member that owes its final read is still open to the watch, and keeps a
 * closed sibling from finishing the watch before that read lands.
 */
function scopeStatus(
  ledger: Ledger,
  readThisPoll: ReadonlySet<T.PrNumber>
): ScopeStatus {
  const merged: T.MergedPr[] = [];
  const closed: T.PrContext[] = [];
  const stillOpen: T.PrContext[] = [];
  let finalReadOwed = false;
  for (const number of ledger.scope) {
    const context = { ...ledger.repository, number };
    const pr = memberLedger(ledger, number);
    const lifecycle = pr.lifecycle;
    if (owesFinalRead(pr)) {
      finalReadOwed = true;
      stillOpen.push(context);
    } else if (lifecycle.kind === "merged")
      merged.push({ kind: "merged-pr", context, mergedAt: lifecycle.mergedAt });
    else if (lifecycle.kind === "closed" && readThisPoll.has(number))
      closed.push(context);
    else stillOpen.push(context);
  }
  const closedMembers = nonEmpty(closed);
  if (closedMembers !== null && !finalReadOwed)
    return {
      kind: "finished",
      result: { kind: "closed", closed: closedMembers, merged, stillOpen },
    };
  const frontier = stillOpen[0];
  if (frontier !== undefined) return { kind: "open", frontier };
  const allMerged = nonEmpty(merged);
  if (allMerged === null) throw new Error("monitor scope cannot be empty");
  return { kind: "finished", result: { kind: "all-merged", merged: allMerged } };
}

interface FrontierView {
  readonly ci: T.CiState;
  readonly ready: boolean;
}
function frontierCondition(
  pr: PrLedger,
  view: FrontierView | null
): MonitorCondition {
  if (view === null || LANES.some((lane) => pr.outages[lane].active))
    return "status-unavailable";
  if (CONDITION_KINDS.some((kind) => pr.conditions[kind].active))
    return "blocked";
  if (view.ci.kind === "ci-pending") return "pending-checks";
  if (view.ready) return "merge-ready";
  return "awaiting-human";
}

function scopeContexts(ledger: Ledger): T.NonEmpty<T.PrContext> {
  const [first, ...rest] = ledger.scope;
  return [
    { ...ledger.repository, number: first },
    ...rest.map((number) => ({ ...ledger.repository, number })),
  ];
}

interface MonitorDependencies {
  readonly reader: T.GitHubReader;
  readonly feedback: FeedbackReader;
  readonly clock: WatchClock;
  readonly stamp: MonitorStamp;
  readonly emit: (verdict: MonitorVerdict) => void;
}

async function monitor(args: {
  readonly dependencies: MonitorDependencies;
  readonly stateDirectory: string;
  readonly ledger: Ledger;
  readonly options: T.PollingOptions;
}): Promise<MonitorTerminalVerdict> {
  const { reader, feedback, clock, stamp, emit } = args.dependencies;
  const { options, stateDirectory } = args;
  let ledger = args.ledger;
  const repository = ledger.repository;
  const started = clock.now();
  let nextSweepAt = started;
  let lastProgress: string | null = null;
  const failures = new Map<string, number>();
  while (true) {
    const now = clock.now();
    const sweep = now >= nextSweepAt;
    if (sweep) nextSweepAt = now + options.sweepInterval;
    const environment: Environment = {
      repository,
      observedAt: clock.observedAt(),
      allowDraft: options.allowDraft,
    };
    const poll: {
      worst: { readonly failure: T.QueryFailure; readonly count: number } | null;
    } = { worst: null };
    const attempt = async <V>(
      pr: T.PrNumber,
      lane: MonitorLane,
      read: () => Promise<V>,
      finalRead = false
    ): Promise<V | null> => {
      const key = `${pr}:${lane}`;
      try {
        const value = await read();
        failures.delete(key);
        if (memberLedger(ledger, pr).outages[lane].active)
          ledger = updateMember(ledger, pr, (step) =>
            recoverLane(step, lane, environment)
          );
        return value;
      } catch (error) {
        if (!(error instanceof WatcherQueryError)) throw error;
        const count = (failures.get(key) ?? 0) + 1;
        failures.set(key, count);
        if (poll.worst === null || count > poll.worst.count)
          poll.worst = { failure: error.failure, count };
        if (!error.failure.retryable || count >= options.maxQueryErrors)
          ledger = updateMember(ledger, pr, (step) =>
            markLaneUnavailable(step, lane, error.failure, environment, finalRead)
          );
        return null;
      }
    };
    const readFeedback = async (
      number: T.PrNumber,
      context: T.PrContext,
      finalRead = false
    ): Promise<FeedbackSnapshot | null> => {
      const snapshot = await attempt(
        number,
        "feedback",
        () => feedback.feedback(context),
        finalRead
      );
      if (snapshot !== null) {
        const delivered = deliveredFeedback(ledger, number);
        ledger = updateMember(ledger, number, (step) => {
          observeFeedback(step, snapshot, delivered, environment);
          if (finalRead) finishFinalRead(step);
        });
      }
      return snapshot;
    };
    const readThisPoll = new Set<T.PrNumber>();
    let frontier: T.PrNumber | null = null;
    let frontierView: FrontierView | null = null;
    for (const number of ledger.scope) {
      const context = { ...repository, number };
      // A merged member stays merged, so the lifecycle lane has nothing left
      // to tell about it.
      const facts =
        memberLedger(ledger, number).lifecycle.kind === "merged"
          ? null
          : await attempt(number, "lifecycle", () =>
              reader.pullRequest(context)
            );
      if (facts !== null) {
        readThisPoll.add(number);
        ledger = updateMember(ledger, number, (step) =>
          observeLifecycle(step, facts, environment)
        );
      }
      const member = memberLedger(ledger, number);
      // The final read, owed since the poll that first saw the member merged
      // or closed. A failed one stays owed in the saved ledger, so every later
      // poll and every later arm retries it, with backoff, until it lands or
      // its lane gives up, whatever the lifecycle lane reads meanwhile.
      if (owesFinalRead(member)) {
        await readFeedback(number, context, true);
        continue;
      }
      const lifecycle = member.lifecycle.kind;
      if (lifecycle === "merged" || lifecycle === "closed") continue;
      frontier ??= number;
      const isFrontier = frontier === number;
      if (!isFrontier && !sweep) continue;
      const snapshot = await readFeedback(number, context);
      if (facts === null) continue;
      const ci = await attempt(number, "ci", () => readCi(reader, facts));
      if (ci === null) continue;
      ledger = updateMember(ledger, number, (step) =>
        observeCi(step, ci, facts, environment)
      );
      if (!isFrontier) continue;
      const ready =
        snapshot === null
          ? null
          : mergeReadyProof(facts, ci, snapshot, options.allowDraft);
      if (ready !== null)
        ledger = updateMember(ledger, number, (step) =>
          queueMergeReady(step, environment, facts.headRefOid, ready)
        );
      frontierView = { ci, ready: ready !== null };
    }
    saveLedger(stateDirectory, ledger);
    const attention = ledger.items.filter((item) => !item.acknowledged);
    const status = scopeStatus(ledger, readThisPoll);
    // A held item never wakes the agent alone. It goes out with a batch that
    // another item wakes, or with the last batch when the watch finishes.
    const wake =
      attention.some((item) => !item.held) ||
      (status.kind === "finished" && attention.length > 0);
    if (wake) {
      const batch = writeBatch(stateDirectory, {
        repository,
        createdAt: environment.observedAt,
        items: attention,
      });
      return stamp({
        kind: "ATTENTION",
        terminal: true,
        exitCode: 8,
        batch: {
          ...batch,
          count: attention.length,
          preview: attention.slice(0, PREVIEW_LIMIT).map((item) => ({
            id: item.id,
            pr: item.pr,
            kind: item.kind,
            excerpt: item.excerpt,
          })),
        },
      });
    }
    if (status.kind === "finished")
      return stamp({
        kind: "FINISHED",
        terminal: true,
        exitCode: 0,
        result: status.result,
      });
    if (options.timeout > 0 && clock.now() - started >= options.timeout)
      return stamp({
        kind: "MONITOR_TIMEOUT",
        terminal: true,
        exitCode: 5,
        scope: scopeContexts(ledger),
        frontier: status.frontier,
      });
    if (poll.worst !== null) {
      const retryInSeconds = queryBackoffSeconds(
        options.interval,
        poll.worst.count
      );
      emit(
        stamp({
          kind: "RETRY",
          terminal: false,
          failure: poll.worst.failure,
          consecutiveFailures: poll.worst.count,
          retryInSeconds,
        })
      );
      lastProgress = null;
      await clock.sleep(retryInSeconds);
      continue;
    }
    const condition = frontierCondition(
      memberLedger(ledger, status.frontier.number),
      frontierView
    );
    const progress = `${status.frontier.number}:${condition}`;
    if (progress !== lastProgress)
      emit(
        stamp({
          kind: "MONITORING",
          terminal: false,
          frontier: status.frontier,
          condition,
        })
      );
    lastProgress = progress;
    await clock.sleep(options.interval);
  }
}

const sameList = (
  left: readonly T.PrNumber[],
  right: readonly T.PrNumber[]
): boolean =>
  left.length === right.length &&
  left.every((number, index) => right[index] === number);

async function reviseQueuedScope(args: {
  readonly saved: Ledger;
  readonly requested: T.NonEmpty<T.PrNumber>;
  readonly reader: T.GitHubReader;
  readonly path: string;
  readonly at: string;
}): Promise<Ledger> {
  const { saved, requested, path } = args;
  const savedMembers = new Set(saved.scope);
  const kept = requested.filter((number) => savedMembers.has(number));
  const appended = requested.filter((number) => !savedMembers.has(number));
  const keptMembers = new Set(kept);
  const mismatch = (reason: string): MonitorStateError =>
    new MonitorStateError(
      path,
      `--stack-prs ${requested.join(",")} does not match the saved queue ${saved.scope.join(",")}: ${reason}`
    );
  if (!sameList(requested, [...kept, ...appended]))
    throw mismatch("new PRs may only be appended after the saved members");
  if (!sameList(saved.scope.filter((number) => keptMembers.has(number)), kept))
    throw mismatch("saved members must keep their order");
  for (const number of saved.scope) {
    if (keptMembers.has(number)) continue;
    if (memberLedger(saved, number).lifecycle.kind === "merged") continue;
    const facts = await args.reader.pullRequest({ ...saved.repository, number });
    if (!isMerged(facts))
      throw mismatch(`#${number} is dropped but not merged`);
  }
  const known = new Set(saved.prs.map((pr) => pr.number));
  return {
    ...saved,
    scope: requested,
    scopeRevisions: [
      ...saved.scopeRevisions,
      { from: saved.scope, to: requested, at: args.at },
    ],
    prs: [
      ...saved.prs,
      ...appended.filter((number) => !known.has(number)).map(newPrLedger),
    ],
  };
}

export type Lifetime =
  | { readonly kind: "until-ready" }
  | {
      readonly kind: "until-merged";
      /** Null derives the babysit skill's directory from the watched scope. */
      readonly stateDirectory: string | null;
      readonly acknowledge: readonly AttentionId[];
    };
export function collectAck(
  value: string,
  previous: readonly AttentionId[]
): readonly AttentionId[] {
  if (!isAttentionId(value))
    throw new InvalidArgumentError("must be a 64-character attention id");
  return [...previous, value];
}

export interface UntilMergedCommand {
  readonly runtime: CliRuntime;
  readonly feedback: FeedbackReader;
  readonly pretty: boolean;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
  readonly mode: T.WatchMode;
  readonly stackPrs: readonly T.PrNumber[];
  readonly polling: T.PollingOptions;
  readonly stateDirectory: string | null;
  readonly acknowledge: readonly AttentionId[];
}
type StatefulCommand = Omit<UntilMergedCommand, "stateDirectory"> & {
  readonly stateDirectory: string;
};

/**
 * The state directory the babysit skill prescribes: `<pr>` for one PR, and
 * `<root-pr>-stack` for a stack, named by the PR the command passes first.
 */
function defaultStateDirectory(home: string, seed: T.PrContext, command: UntilMergedCommand): string {
  const root = command.stackPrs[0] ?? seed.number;
  const name = command.mode === "single" ? `${root}` : `${root}-stack`;
  return join(home, ".local", "state", "pi-agent", seed.repo, "babysit", name);
}

function statusQueryBlocker(stamp: MonitorStamp, error: unknown): MonitorTerminalVerdict {
  if (!(error instanceof WatcherQueryError)) throw error;
  return stamp({
    kind: "BLOCKER",
    terminal: true,
    exitCode: 7,
    blocker: { kind: "status-query", failures: 1, failure: error.failure },
  });
}

function resolveScope(command: UntilMergedCommand): Promise<T.PrContext> {
  return resolveContext({
    reader: command.runtime.reader,
    owner: command.owner,
    repo: command.repo,
    pr: command.pr ?? command.stackPrs[0] ?? null,
  });
}

async function openLedger(command: StatefulCommand): Promise<Ledger> {
  const { runtime, mode, stateDirectory } = command;
  const path = statePath(stateDirectory);
  const saved = loadLedger(stateDirectory);
  const seed = await resolveScope(command);
  const requested = nonEmpty(command.stackPrs);
  if (saved === null) {
    let scope: T.NonEmpty<T.PrNumber> = [seed.number];
    if (requested !== null) scope = requested;
    else if (mode !== "single")
      scope = nonEmpty(
        (await discoverStack(runtime.reader, seed)).map((pr) => pr.number)
      ) ?? [seed.number];
    return {
      version: 1,
      repository: { owner: seed.owner, repo: seed.repo },
      mode,
      scope,
      scopeRevisions: [],
      prs: scope.map(newPrLedger),
      items: [],
    };
  }
  const owner = `${saved.repository.owner}/${saved.repository.repo}`;
  if (owner !== `${seed.owner}/${seed.repo}` || saved.mode !== mode)
    throw new MonitorStateError(
      path,
      `state watches ${owner} in ${saved.mode} mode, not ${seed.owner}/${seed.repo} in ${mode} mode`
    );
  if (mode === "queued-stack") {
    if (requested === null || sameList(requested, saved.scope)) return saved;
    return reviseQueuedScope({
      saved,
      requested,
      reader: runtime.reader,
      path,
      at: runtime.clock.observedAt(),
    });
  }
  const matches =
    mode === "single"
      ? sameList(saved.scope, [seed.number])
      : saved.scope.includes(seed.number);
  if (!matches)
    throw new MonitorStateError(
      path,
      `state watches ${saved.scope.map((number) => `#${number}`).join(",")}, which does not cover #${seed.number}`
    );
  return saved;
}

async function watchLocked(
  command: StatefulCommand,
  stamp: MonitorStamp,
  print: (verdict: MonitorVerdict) => void
): Promise<number> {
  const { runtime, stateDirectory } = command;
  let opened: Ledger;
  try {
    opened = await openLedger(command);
  } catch (error) {
    const verdict = statusQueryBlocker(stamp, error);
    print(verdict);
    return verdict.exitCode;
  }
  const { ledger, unknown } = acknowledge(opened, command.acknowledge);
  for (const id of unknown)
    runtime.stderr(
      `watch-pr: ignoring --ack ${id}: this state never delivered it (state: ${statePath(stateDirectory)})\n`
    );
  saveLedger(stateDirectory, ledger);
  const verdict = await monitor({
    dependencies: {
      reader: runtime.reader,
      feedback: command.feedback,
      clock: runtime.clock,
      stamp,
      emit: print,
    },
    stateDirectory,
    ledger,
    options: command.polling,
  });
  print(verdict);
  return verdict.exitCode;
}

export async function runUntilMerged(
  command: UntilMergedCommand
): Promise<number> {
  const { runtime } = command;
  const stamp = monitorStamp(runtime.clock, command.mode);
  const print = (verdict: MonitorVerdict): void =>
    runtime.stdout(renderMonitor(verdict, command.pretty));
  const reportStateError = (error: unknown): number => {
    if (!(error instanceof MonitorStateError)) throw error;
    runtime.stderr(`watch-pr: ${error.message}\n`);
    return 73;
  };
  let stateDirectory = command.stateDirectory;
  if (stateDirectory === null) {
    try {
      stateDirectory = defaultStateDirectory(runtime.home, await resolveScope(command), command);
    } catch (error) {
      const verdict = statusQueryBlocker(stamp, error);
      print(verdict);
      return verdict.exitCode;
    }
    runtime.stderr(`watch-pr: state ${stateDirectory}\n`);
  }
  let lock: StateLock;
  try {
    lock = lockState(stateDirectory);
  } catch (error) {
    return reportStateError(error);
  }
  try {
    return await watchLocked({ ...command, stateDirectory }, stamp, print);
  } catch (error) {
    return reportStateError(error);
  } finally {
    try {
      unlockState(lock);
    } catch (error) {
      reportStateError(error);
    }
  }
}
