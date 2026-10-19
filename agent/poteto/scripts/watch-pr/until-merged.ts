import { createHash } from "node:crypto";
import type { CliRuntime } from "./cli.ts";
import { WatcherQueryError, discoverStack, resolveContext } from "./github.ts";
import {
  CONDITION_KINDS,
  LANES,
  type Ledger,
  MonitorStateError,
  type MonitorLane,
  type PrLedger,
  type StoredItem,
  loadLedger,
  newPrLedger,
  saveLedger,
  statePath,
  writeBatch,
} from "./monitor-state.ts";
import {
  ciBlocker,
  conflictBlocker,
  gateBlocker,
  queryBackoffSeconds,
  readSnapshot,
  readyContribution,
  statusQueryVerdict,
  verdictFactory,
  type RunDependencies,
} from "./policy.ts";
import type * as T from "./types.ts";
import { isAttentionId, nonEmpty } from "./types.ts";

const PROTOCOL_VERSION = 1;
const PREVIEW_LIMIT = 20;
const EXCERPT_LIMIT = 200;
const REPLY_MARKER = /^<!-- pi-event:([0-9a-f]{64}) -->$/;

type OpenSnapshot = Extract<T.PrSnapshot, { readonly kind: "open" }>;
type Observation =
  | { readonly kind: "lifecycle"; readonly facts: T.PullRequestFacts }
  | {
      readonly kind: "feedback";
      readonly pr: T.PrNumber;
      readonly snapshot: T.FeedbackSnapshot;
    }
  | {
      readonly kind: "ci";
      readonly snapshot: OpenSnapshot;
      readonly frontier: boolean;
    }
  | {
      readonly kind: "lane-unavailable";
      readonly pr: T.PrNumber;
      readonly lane: MonitorLane;
      readonly failure: T.QueryFailure;
    };
interface ReduceEnvironment {
  readonly repository: T.Repository;
  readonly observedAt: string;
  readonly allowDraft: boolean;
}
interface PrStep {
  pr: PrLedger;
  readonly queued: StoredItem[];
  readonly acknowledged: Set<T.AttentionId>;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
function attentionId(
  repository: T.Repository,
  parts: readonly (string | number | boolean | null)[]
): T.AttentionId {
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
  // parseLedger and every scope change keep a ledger entry per scope member.
  if (found === undefined) throw new Error(`no ledger entry for #${number}`);
  return found;
}

function queue(
  step: PrStep,
  environment: ReduceEnvironment,
  item: Pick<StoredItem, "id" | "kind" | "excerpt" | "detail">
): void {
  step.queued.push({
    ...item,
    excerpt: excerpt(item.excerpt),
    pr: step.pr.number,
    acknowledged: false,
    observedAt: environment.observedAt,
  });
}

function recoverLane(
  step: PrStep,
  lane: MonitorLane,
  environment: ReduceEnvironment
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

function markLaneUnavailable(
  step: PrStep,
  lane: MonitorLane,
  failure: T.QueryFailure,
  environment: ReduceEnvironment
): void {
  const outage = step.pr.outages[lane];
  if (outage.active) return;
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
    excerpt: `${lane} reads for #${step.pr.number} keep failing: ${failure.detail}`,
    detail: { lane, outageGeneration: generation, failure },
  });
}

interface Revision {
  readonly subject: "review" | "comment" | "thread-comment";
  readonly nodeId: string;
  readonly authorLogin: string | null;
  readonly body: string;
  readonly updatedAt: string;
  readonly reviewState: T.SubmittedReviewState | null;
  readonly inResolvedThread: boolean;
  readonly detail: Record<string, unknown>;
}
function revisions(snapshot: T.FeedbackSnapshot): readonly Revision[] {
  const all: Revision[] = [];
  for (const review of snapshot.reviews)
    all.push({
      subject: "review",
      nodeId: review.id,
      authorLogin: review.authorLogin,
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

/** Only `<!-- pi-event:<id> -->` lines at the very end of the body count, so a quoted marker claims nothing. */
function replyMarkers(body: string): readonly T.AttentionId[] {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const ids: T.AttentionId[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const id = REPLY_MARKER.exec(lines[index] ?? "")?.[1];
    if (id === undefined || !isAttentionId(id)) break;
    ids.push(id);
  }
  return ids;
}

function observeFeedback(
  step: PrStep,
  snapshot: T.FeedbackSnapshot,
  deliveredFeedback: ReadonlySet<T.AttentionId>,
  environment: ReduceEnvironment
): void {
  const seen = new Set(step.pr.seenRevisions);
  for (const revision of revisions(snapshot)) {
    if (revision.authorLogin === snapshot.viewerLogin) {
      const markers = replyMarkers(revision.body);
      if (markers.length > 0) {
        for (const id of markers)
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
    });
  }
  step.pr = { ...step.pr, feedbackBaselined: true, seenRevisions: [...seen] };
}

function blockerFacts(blocker: T.MergeBlocker): readonly string[] {
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
    case "review-threads":
      return blocker.threads.map((thread) => thread.id).sort();
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}

function observeChecks(
  step: PrStep,
  snapshot: OpenSnapshot,
  frontier: boolean,
  environment: ReduceEnvironment
): void {
  const head = snapshot.facts.headRefOid;
  const blockers = {
    "merge-conflicts": conflictBlocker(snapshot),
    "failing-checks": ciBlocker(snapshot),
    "merge-gate": gateBlocker(snapshot, environment.allowDraft),
  };
  const conditions = { ...step.pr.conditions };
  for (const kind of CONDITION_KINDS) {
    const blocker = blockers[kind];
    const previous = conditions[kind];
    if (blocker === null) {
      conditions[kind] = { ...previous, active: false };
      continue;
    }
    const generation = previous.active
      ? previous.generation
      : previous.generation + 1;
    conditions[kind] = { active: true, generation };
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
  let ciRecoveryOwed = step.pr.ciRecoveryOwed;
  if (snapshot.ci.kind === "ci-clean" && ciRecoveryOwed) {
    queue(step, environment, {
      id: attentionId(environment.repository, [
        step.pr.number,
        "ci-recovered",
        conditions["failing-checks"].generation,
      ]),
      kind: "ci-recovered",
      excerpt: `CI on #${step.pr.number} is clean again at ${head ?? "unknown head"}`,
      detail: { head, checks: snapshot.ci.all },
    });
    ciRecoveryOwed = false;
  }
  if (blockers["failing-checks"] !== null) ciRecoveryOwed = true;
  step.pr = { ...step.pr, conditions, ciRecoveryOwed };
  const ready = frontier
    ? readyContribution(snapshot, environment.allowDraft)
    : null;
  if (ready?.kind === "ready-pr")
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

function lifecycleOf(facts: T.PullRequestFacts): PrLedger["lifecycle"] {
  if (facts.state === "MERGED" || facts.mergedAt !== null)
    return { kind: "merged", mergedAt: facts.mergedAt };
  if (facts.state === "CLOSED") return { kind: "closed" };
  return { kind: "open" };
}
function observedPr(observation: Observation): T.PrNumber {
  switch (observation.kind) {
    case "lifecycle":
      return observation.facts.context.number;
    case "ci":
      return observation.snapshot.context.number;
    case "feedback":
    case "lane-unavailable":
      return observation.pr;
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
}

function reduce(
  ledger: Ledger,
  observation: Observation,
  environment: ReduceEnvironment
): Ledger {
  const number = observedPr(observation);
  const step: PrStep = {
    pr: memberLedger(ledger, number),
    queued: [],
    acknowledged: new Set(),
  };
  switch (observation.kind) {
    case "lifecycle":
      recoverLane(step, "lifecycle", environment);
      step.pr = { ...step.pr, lifecycle: lifecycleOf(observation.facts) };
      break;
    case "feedback": {
      recoverLane(step, "feedback", environment);
      const delivered = new Set(
        ledger.items.flatMap((item) =>
          item.pr === number && item.kind === "feedback" && !item.acknowledged
            ? [item.id]
            : []
        )
      );
      observeFeedback(step, observation.snapshot, delivered, environment);
      break;
    }
    case "ci":
      recoverLane(step, "ci", environment);
      observeChecks(step, observation.snapshot, observation.frontier, environment);
      break;
    case "lane-unavailable":
      markLaneUnavailable(step, observation.lane, observation.failure, environment);
      break;
    default: {
      const exhaustive: never = observation;
      return exhaustive;
    }
  }
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

function acknowledge(
  ledger: Ledger,
  ids: readonly T.AttentionId[],
  path: string
): Ledger {
  const known = new Set(ledger.items.map((item) => item.id));
  for (const id of ids)
    if (!known.has(id))
      throw new MonitorStateError(
        path,
        `--ack ${id} names no attention item this state delivered`
      );
  const acked = new Set(ids);
  return {
    ...ledger,
    items: ledger.items.map((item) =>
      acked.has(item.id) && !item.acknowledged
        ? { ...item, acknowledged: true }
        : item
    ),
  };
}

type ScopeStatus =
  | {
      readonly kind: "finished";
      readonly result: Extract<
        T.MonitorTerminalVerdict,
        { readonly kind: "FINISHED" }
      >["result"];
    }
  | { readonly kind: "open"; readonly frontier: T.PrContext };
function scopeStatus(ledger: Ledger): ScopeStatus {
  const merged: T.MergedPr[] = [];
  const closed: T.PrContext[] = [];
  const stillOpen: T.PrContext[] = [];
  for (const number of ledger.scope) {
    const context = { ...ledger.repository, number };
    const lifecycle = memberLedger(ledger, number).lifecycle;
    if (lifecycle.kind === "merged")
      merged.push({ kind: "merged-pr", context, mergedAt: lifecycle.mergedAt });
    else if (lifecycle.kind === "closed") closed.push(context);
    else stillOpen.push(context);
  }
  const closedMembers = nonEmpty(closed);
  if (closedMembers !== null)
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

const isLive = (pr: PrLedger): boolean =>
  pr.lifecycle.kind === "open" || pr.lifecycle.kind === "unknown";
function outstanding(ledger: Ledger): readonly StoredItem[] {
  const live = new Set(
    ledger.scope.filter((number) => isLive(memberLedger(ledger, number)))
  );
  return ledger.items.filter((item) => !item.acknowledged && live.has(item.pr));
}

function frontierCondition(
  ledger: Ledger,
  frontier: T.PrNumber,
  snapshot: OpenSnapshot | undefined,
  allowDraft: boolean
): T.MonitorCondition {
  const pr = memberLedger(ledger, frontier);
  if (snapshot === undefined || LANES.some((lane) => pr.outages[lane].active))
    return "status-unavailable";
  if (CONDITION_KINDS.some((kind) => pr.conditions[kind].active))
    return "blocked";
  if (snapshot.ci.kind === "ci-pending") return "pending-checks";
  if (readyContribution(snapshot, allowDraft)?.kind === "ready-pr")
    return "merge-ready";
  return "awaiting-human";
}

async function monitor(args: {
  readonly dependencies: RunDependencies;
  readonly stateDirectory: string;
  readonly ledger: Ledger;
  readonly options: T.PollingOptions;
}): Promise<T.MonitorTerminalVerdict> {
  const { reader, clock, emit } = args.dependencies;
  const { options, stateDirectory } = args;
  let ledger = args.ledger;
  const repository = ledger.repository;
  const stamp = verdictFactory(clock, ledger.mode);
  const started = clock.now();
  let nextSweepAt = started;
  let lastProgress: string | null = null;
  const failures = new Map<string, number>();
  const snapshots = new Map<T.PrNumber, OpenSnapshot>();
  while (true) {
    const now = clock.now();
    const sweep = now >= nextSweepAt;
    if (sweep) nextSweepAt = now + options.sweepInterval;
    const environment = {
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
      read: () => Promise<V>
    ): Promise<V | null> => {
      const key = `${pr}:${lane}`;
      try {
        const value = await read();
        failures.delete(key);
        return value;
      } catch (error) {
        if (!(error instanceof WatcherQueryError)) throw error;
        const count = (failures.get(key) ?? 0) + 1;
        failures.set(key, count);
        if (poll.worst === null || count > poll.worst.count)
          poll.worst = { failure: error.failure, count };
        if (!error.failure.retryable || count >= options.maxQueryErrors)
          ledger = reduce(
            ledger,
            { kind: "lane-unavailable", pr, lane, failure: error.failure },
            environment
          );
        return null;
      }
    };
    let frontier: T.PrNumber | null = null;
    for (const number of ledger.scope) {
      if (!isLive(memberLedger(ledger, number))) continue;
      const context = { ...repository, number };
      const facts = await attempt(number, "lifecycle", () =>
        reader.pullRequest(context)
      );
      if (facts !== null) {
        ledger = reduce(ledger, { kind: "lifecycle", facts }, environment);
        if (!isLive(memberLedger(ledger, number))) continue;
      }
      frontier ??= number;
      const feedback = await attempt(number, "feedback", () =>
        reader.feedback(context)
      );
      if (feedback !== null)
        ledger = reduce(
          ledger,
          { kind: "feedback", pr: number, snapshot: feedback },
          environment
        );
      if (frontier !== number && !sweep) continue;
      const snapshot = await attempt(number, "ci", () =>
        readSnapshot({
          reader,
          context,
          pendingHistory: "include",
          allowDraft: options.allowDraft,
        })
      );
      if (snapshot?.kind !== "open") continue;
      snapshots.set(number, snapshot);
      ledger = reduce(
        ledger,
        { kind: "ci", snapshot, frontier: frontier === number },
        environment
      );
    }
    const status = scopeStatus(ledger);
    if (status.kind === "finished") {
      saveLedger(stateDirectory, ledger);
      return stamp({
        kind: "FINISHED",
        terminal: true,
        exitCode: 0,
        result: status.result,
      });
    }
    const attention = outstanding(ledger);
    if (attention.length > 0) {
      const batch = writeBatch(stateDirectory, {
        repository,
        createdAt: environment.observedAt,
        items: attention,
      });
      saveLedger(stateDirectory, ledger);
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
    saveLedger(stateDirectory, ledger);
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
      ledger,
      status.frontier.number,
      snapshots.get(status.frontier.number),
      options.allowDraft
    );
    const pendingAttentionCount = ledger.items.filter(
      (item) => !item.acknowledged
    ).length;
    const progress = `${status.frontier.number}:${condition}:${pendingAttentionCount}`;
    if (progress !== lastProgress)
      emit(
        stamp({
          kind: "MONITORING",
          terminal: false,
          frontier: status.frontier,
          condition,
          pendingAttentionCount,
        })
      );
    lastProgress = progress;
    await clock.sleep(options.interval);
  }
}

function scopeContexts(ledger: Ledger): T.NonEmpty<T.PrContext> {
  const [first, ...rest] = ledger.scope;
  return [
    { ...ledger.repository, number: first },
    ...rest.map((number) => ({ ...ledger.repository, number })),
  ];
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
    if (lifecycleOf(facts).kind !== "merged")
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

export interface UntilMergedCommand {
  readonly runtime: CliRuntime;
  readonly render: (verdict: T.WatcherVerdict) => string;
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
  readonly mode: T.WatchMode;
  readonly stackPrs: readonly T.PrNumber[];
  readonly polling: T.PollingOptions;
  readonly stateDirectory: string;
  readonly acknowledge: readonly T.AttentionId[];
}

async function openLedger(command: UntilMergedCommand): Promise<Ledger> {
  const { runtime, mode, stateDirectory } = command;
  const path = statePath(stateDirectory);
  const saved = loadLedger(stateDirectory);
  const seed = await resolveContext({
    reader: runtime.reader,
    owner: command.owner,
    repo: command.repo,
    pr: command.pr ?? command.stackPrs[0] ?? null,
  });
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

export async function runUntilMerged(
  command: UntilMergedCommand
): Promise<number> {
  const { runtime, render } = command;
  try {
    let ledger: Ledger;
    try {
      ledger = await openLedger(command);
    } catch (error) {
      if (!(error instanceof WatcherQueryError)) throw error;
      const verdict = statusQueryVerdict(
        verdictFactory(runtime.clock, command.mode),
        1,
        error.failure
      );
      runtime.stdout(render(verdict));
      return verdict.exitCode;
    }
    ledger = acknowledge(
      ledger,
      command.acknowledge,
      statePath(command.stateDirectory)
    );
    saveLedger(command.stateDirectory, ledger);
    const verdict = await monitor({
      dependencies: {
        reader: runtime.reader,
        clock: runtime.clock,
        emit: (progress) => runtime.stdout(render(progress)),
      },
      stateDirectory: command.stateDirectory,
      ledger,
      options: command.polling,
    });
    runtime.stdout(render(verdict));
    return verdict.exitCode;
  } catch (error) {
    if (!(error instanceof MonitorStateError)) throw error;
    runtime.stderr(`watch-pr: ${error.message}\n`);
    return 73;
  }
}
