import type {
  Check,
  ChecksFastPath,
  CommitRollup,
  FeedbackSnapshot,
  GitHubReader,
  OpenPullRequest,
  PrContext,
  PullRequestFacts,
  QueryFailure,
  Repository,
  RawReviewThread,
  ReviewThread,
  ReviewThreadPage,
  RollupPage,
} from "./types.ts";
import { parsePrNumber } from "./types.ts";
import { WatcherQueryError } from "./github.ts";

export type FeedbackFrame =
  | { readonly kind: "snapshot"; readonly snapshot: FeedbackSnapshot }
  | { readonly kind: "failure"; readonly failure: QueryFailure };

export const emptyFeedback: FeedbackSnapshot = {
  viewerLogin: "viewer",
  reviews: [],
  comments: [],
  threads: [],
};

export interface FakeReaderOptions {
  readonly facts?: Partial<Omit<PullRequestFacts, "context">>;
  readonly fastPath?: ChecksFastPath;
  readonly rollupPages?: readonly RollupPage[];
  readonly threads?: readonly ReviewThread[];
  readonly threadPages?: readonly ReviewThreadPage[];
  readonly commitRollups?: readonly CommitRollup[];
  readonly openPullRequests?: readonly OpenPullRequest[];
  readonly origin?: Repository | null;
  readonly current?: PrContext;
  /** Per PR number. Each `feedback` call takes the next frame; the last one repeats. */
  readonly feedbackFrames?: ReadonlyMap<number, readonly FeedbackFrame[]>;
}

function toRawThread(thread: ReviewThread): RawReviewThread {
  return { id: thread.id, firstComment: thread.firstComment, resolved: false };
}

export function passingCheck(name = "ci"): Check {
  return {
    kind: "passed",
    name,
    reportedState: "SUCCESS",
    description: "",
    link: "",
    workflow: "",
  };
}

export function pendingCheck(name = "ci"): Check {
  return {
    kind: "pending",
    name,
    reportedState: "PENDING",
    description: "",
    link: "",
    workflow: "",
  };
}

export function failedCheck(name = "ci"): Check {
  return {
    kind: "failed",
    name,
    reportedState: "FAILURE",
    description: "",
    link: "",
    workflow: "",
  };
}

export function fakeReader(
  options: FakeReaderOptions = {}
): GitHubReader & { readonly calls: readonly string[] } {
  const calls: string[] = [];
  const context = options.current ?? {
    owner: "owner",
    repo: "repo",
    number: parsePrNumber(1),
  };
  const defaults: PullRequestFacts = {
    context,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };
  let page = 0;
  let threadPage = 0;
  const feedbackReads = new Map<number, number>();
  return {
    calls,
    async originRepo() {
      calls.push("originRepo");
      return options.origin === undefined
        ? { owner: "owner", repo: "repo" }
        : options.origin;
    },
    async currentPr(pr) {
      calls.push("currentPr");
      return { ...context, number: pr ?? context.number };
    },
    async pullRequest(requested) {
      calls.push("pullRequest");
      return { ...defaults, ...options.facts, context: requested };
    },
    async openPullRequests() {
      calls.push("openPullRequests");
      return options.openPullRequests ?? [];
    },
    async checksFastPath() {
      calls.push("checksFastPath");
      return options.fastPath ?? { kind: "checks", checks: [passingCheck()] };
    },
    async checkRollupPage(_requested, after) {
      calls.push(`checkRollupPage:${after ?? "null"}`);
      return options.rollupPages?.[page++] ?? { checks: [], endCursor: null };
    },
    async reviewThreadPage(_requested, after) {
      calls.push(`reviewThreadPage:${after ?? "null"}`);
      return options.threadPages?.[threadPage++] ?? {
        threads: (options.threads ?? []).map(toRawThread),
        endCursor: null,
      };
    },
    async commitRollups() {
      calls.push("commitRollups");
      return options.commitRollups ?? [{ oid: "head", state: "SUCCESS" }];
    },
    async feedback(requested) {
      calls.push("feedback");
      const frames = options.feedbackFrames?.get(requested.number) ?? [];
      const index = feedbackReads.get(requested.number) ?? 0;
      feedbackReads.set(requested.number, index + 1);
      const frame = frames[Math.min(index, frames.length - 1)];
      if (frame === undefined) return emptyFeedback;
      if (frame.kind === "failure") throw new WatcherQueryError(frame.failure);
      return frame.snapshot;
    },
  };
}
