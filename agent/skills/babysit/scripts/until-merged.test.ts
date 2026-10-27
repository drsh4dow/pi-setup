import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import type {
  FeedbackComment,
  FeedbackReader,
  FeedbackSnapshot,
  FeedbackThread,
  SubmittedReview,
  SubmittedReviewState,
} from "./feedback.ts";
import { WatcherQueryError } from "./github.ts";
import {
  failedCheck,
  fakeReader,
  passingCheck,
  pendingCheck,
} from "./fakes.test-helper.ts";
import type {
  ChecksFastPath,
  CommitRollup,
  GitHubReader,
  OpenPullRequest,
  PrContext,
  PullRequestFacts,
  QueryFailure,
  RollupPage,
} from "./types.ts";
import { parsePrNumber } from "./types.ts";

type FeedbackFrame =
  | { readonly kind: "snapshot"; readonly snapshot: FeedbackSnapshot }
  | { readonly kind: "failure"; readonly failure: QueryFailure };
const emptyFeedback: FeedbackSnapshot = {
  viewerLogin: "viewer",
  reviews: [],
  comments: [],
  threads: [],
};

interface World {
  readonly facts: Map<number, Partial<Omit<PullRequestFacts, "context">>>;
  readonly checks: Map<number, ChecksFastPath>;
  readonly rollups: Map<number, RollupPage>;
  readonly commitRollups: Map<number, readonly CommitRollup[]>;
  readonly feedback: Map<number, FeedbackFrame>;
  readonly feedbackReads: number[];
  readonly open: OpenPullRequest[];
  onSleep: (now: number) => void;
  beforePullRequest: () => Promise<void>;
}
interface BatchItem {
  readonly id: string;
  readonly pr: number;
  readonly kind: string;
  readonly excerpt: string;
  readonly detail: { readonly body?: string; readonly lane?: string };
}
interface Watch {
  readonly code: number;
  readonly records: readonly Record<string, unknown>[];
  readonly stderr: string;
  readonly items: readonly BatchItem[];
}

const pending: ChecksFastPath = { kind: "checks", checks: [pendingCheck()] };
const passing: ChecksFastPath = { kind: "checks", checks: [passingCheck()] };
const failing = (link = ""): ChecksFastPath => ({
  kind: "checks",
  checks: [{ ...failedCheck("build"), link }],
});
const unavailable: ChecksFastPath = {
  kind: "unusable",
  exitCode: 1,
  stderr: "checks API down",
};
const outage: QueryFailure = {
  kind: "command-exit",
  retryable: true,
  detail: "HTTP 502",
  code: 1,
};

let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "watch-pr-monitor-"));
});
afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

function world(): World {
  return {
    facts: new Map(),
    checks: new Map(),
    rollups: new Map(),
    commitRollups: new Map(),
    feedback: new Map(),
    feedbackReads: [],
    open: [],
    onSleep: () => {},
    beforePullRequest: async () => {},
  };
}
function readerFor(scene: World): GitHubReader {
  const base = fakeReader({ openPullRequests: scene.open });
  return {
    ...base,
    async pullRequest(context: PrContext) {
      await scene.beforePullRequest();
      const facts = await base.pullRequest(context);
      return { ...facts, ...scene.facts.get(context.number), context };
    },
    async checksFastPath(context: PrContext) {
      return scene.checks.get(context.number) ?? pending;
    },
    async checkRollupPage(context: PrContext, after: string | null) {
      return (
        scene.rollups.get(context.number) ??
        base.checkRollupPage(context, after)
      );
    },
    async commitRollups(context: PrContext) {
      return (
        scene.commitRollups.get(context.number) ?? base.commitRollups(context)
      );
    },
    async reviewThreadPage() {
      throw new Error("the monitor reads threads through the feedback reader");
    },
  };
}
function feedbackFor(scene: World): FeedbackReader {
  return {
    async feedback(context) {
      scene.feedbackReads.push(context.number);
      const frame = scene.feedback.get(context.number);
      if (frame === undefined) return emptyFeedback;
      if (frame.kind === "failure") throw new WatcherQueryError(frame.failure);
      return frame.snapshot;
    },
  };
}
function batchItems(records: readonly Record<string, unknown>[]) {
  const last = records.at(-1);
  if (last?.kind !== "ATTENTION") return [];
  const batch = last.batch;
  if (typeof batch !== "object" || batch === null || !("path" in batch))
    throw new Error("ATTENTION without a batch path");
  const contents: { items: BatchItem[] } = JSON.parse(
    readFileSync(String(batch.path), "utf8")
  );
  return contents.items;
}
async function watch(scene: World, args: readonly string[] = []): Promise<Watch> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let now = 0;
  const code = await main(
    [
      "--owner",
      "owner",
      "--repo",
      "repo",
      "--pr",
      "1",
      "--until-merged",
      "--state",
      state,
      "--interval",
      "10",
      "--timeout",
      "60",
      ...args,
    ],
    {
      reader: readerFor(scene),
      clock: {
        now: () => now,
        observedAt: () => new Date(Date.UTC(2026, 0, 1) + now * 1000).toISOString(),
        async sleep(seconds) {
          now += seconds;
          scene.onSleep(now);
        },
      },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      home: "/nonexistent/watch-pr-home",
    },
    feedbackFor(scene)
  );
  const records: Record<string, unknown>[] = stdout
    .join("")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  return { code, records, stderr: stderr.join(""), items: batchItems(records) };
}
const acks = (items: readonly BatchItem[]): string[] =>
  items.flatMap((item) => ["--ack", item.id]);

function comment(
  id: string,
  author: string,
  body: string,
  updatedAt = "2026-01-01T00:00:00Z"
): FeedbackComment {
  return {
    id,
    authorLogin: author,
    authorIsBot: false,
    body,
    url: `https://github.com/owner/repo/pull/1#${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt,
  };
}
function review(
  id: string,
  author: string,
  reviewState: SubmittedReviewState,
  body = ""
): SubmittedReview {
  return {
    ...comment(id, author, body),
    state: reviewState,
    submittedAt: "2026-01-01T00:00:00Z",
  };
}
/** A comment by a GraphQL Bot account, whose login has no [bot] suffix. */
function botComment(
  id: string,
  body: string,
  updatedAt = "2026-01-01T00:00:00Z"
): FeedbackComment {
  return { ...comment(id, "coderabbitai", body, updatedAt), authorIsBot: true };
}
function thread(
  id: string,
  isResolved: boolean,
  comments: readonly FeedbackComment[]
): FeedbackThread {
  return {
    id,
    isResolved,
    comments: comments.map((item) => ({ ...item, path: "a.ts", line: 1 })),
  };
}
function feedback(parts: Partial<FeedbackSnapshot>): FeedbackFrame {
  return {
    kind: "snapshot",
    snapshot: { ...emptyFeedback, viewerLogin: "operator", ...parts },
  };
}
const marker = (id: string): string => `<!-- pi-event:${id} -->`;
const ownReply = "<!-- pi-event:reply -->";
const mergedFacts = { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" } as const;
const lockPath = (): string => join(state, "watcher.lock");
const kinds = (items: readonly BatchItem[]) =>
  items.map((item) => [item.pr, item.kind, item.excerpt.split(":")[0]]);

describe("merge-ready is attention, not an exit", () => {
  it("wakes once per head for a green unreviewed PR, then waits", async () => {
    const scene = world();
    scene.checks.set(1, passing);
    scene.facts.set(1, { reviewDecision: "REVIEW_REQUIRED" });
    const first = await watch(scene);
    expect(first.code).toBe(8);
    expect(first.items.map((item) => item.kind)).toEqual(["merge-ready"]);

    const quiet = await watch(scene, acks(first.items));
    expect(quiet.code).toBe(5);
    expect(quiet.records.at(-1)).toMatchObject({ kind: "MONITOR_TIMEOUT" });
    expect(quiet.records).toContainEqual(
      expect.objectContaining({ kind: "MONITORING", condition: "merge-ready" })
    );

    scene.facts.set(1, { reviewDecision: "REVIEW_REQUIRED", headRefOid: "next" });
    scene.checks.set(1, passing);
    const rehead = await watch(scene);
    expect(rehead.code).toBe(8);
    expect(rehead.items.map((item) => item.kind)).toEqual(["merge-ready"]);
    expect(rehead.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("wakes once for a PR with no checks, then waits", async () => {
    const scene = world();
    scene.checks.set(1, {
      kind: "unusable",
      exitCode: 1,
      stderr: "no checks reported on the 'feature' branch",
    });
    scene.rollups.set(1, { kind: "no-rollup" });
    scene.commitRollups.set(1, [{ oid: "head", state: null }]);
    const first = await watch(scene);
    expect(first.code).toBe(8);
    expect(first.items.map((item) => item.kind)).toEqual(["merge-ready"]);
    const quiet = await watch(scene, acks(first.items));
    expect(quiet.code).toBe(5);
    expect(quiet.records).toContainEqual(
      expect.objectContaining({ kind: "MONITORING", condition: "merge-ready" })
    );
  });

  it("wakes on a later review while the PR sits merge-ready", async () => {
    const scene = world();
    scene.checks.set(1, passing);
    const first = await watch(scene);
    scene.onSleep = (now) => {
      if (now >= 30)
        scene.feedback.set(
          1,
          feedback({ reviews: [review("r1", "alice", "CHANGES_REQUESTED")] })
        );
    };
    const later = await watch(scene, acks(first.items));
    expect(later.code).toBe(8);
    expect(later.items.map((item) => item.kind)).toEqual(["feedback"]);
  });
});

describe("feedback revisions", () => {
  it("queues history on the first read except resolved threads, then any new comment", async () => {
    const scene = world();
    scene.feedback.set(
      1,
      feedback({
        reviews: [review("r1", "coderabbitai", "COMMENTED", "outside-diff finding")],
        comments: [comment("c1", "alice", "please rename")],
        threads: [
          thread("t-open", false, [comment("o1", "bob", "bug here")]),
          thread("t-done", true, [comment("d1", "bob", "old nit")]),
        ],
      })
    );
    const first = await watch(scene);
    expect(first.items.map((item) => item.detail.body).sort()).toEqual([
      "bug here",
      "outside-diff finding",
      "please rename",
    ]);

    scene.feedback.set(
      1,
      feedback({
        reviews: [review("r1", "coderabbitai", "COMMENTED", "outside-diff finding")],
        comments: [comment("c1", "alice", "please rename")],
        threads: [
          thread("t-open", false, [comment("o1", "bob", "bug here")]),
          thread("t-done", true, [
            comment("d1", "bob", "old nit"),
            comment("d2", "bob", "actually, one more"),
          ]),
        ],
      })
    );
    const second = await watch(scene, acks(first.items));
    expect(second.items.map((item) => item.detail.body)).toEqual([
      "actually, one more",
    ]);
  });

  it("does not baseline anything when the first read fails", async () => {
    const scene = world();
    scene.feedback.set(1, { kind: "failure", failure: outage });
    scene.onSleep = () =>
      scene.feedback.set(
        1,
        feedback({
          threads: [thread("t-done", true, [comment("d1", "bob", "old nit")])],
          comments: [comment("c1", "alice", "hello")],
        })
      );
    const result = await watch(scene);
    expect(result.code).toBe(8);
    expect(result.items.map((item) => item.detail.body)).toEqual(["hello"]);
  });

  it("wakes on an edit, and acknowledging the old revision does not cover it", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "v1")] }));
    const first = await watch(scene);
    scene.feedback.set(
      1,
      feedback({ comments: [comment("c1", "alice", "v2", "2026-01-01T00:00:00Z")] })
    );
    const edited = await watch(scene, acks(first.items));
    expect(edited.code).toBe(8);
    expect(edited.items.map((item) => item.detail.body)).toEqual(["v2"]);
  });

  it("separates the operator's own comments from the agent's marked replies", async () => {
    const scene = world();
    scene.feedback.set(
      1,
      feedback({
        threads: [thread("t1", false, [comment("h1", "operator", "same login, human")])],
      })
    );
    const first = await watch(scene);
    expect(first.items.map((item) => item.detail.body)).toEqual([
      "same login, human",
    ]);
    const delivered = first.items[0]?.id ?? "";

    const answered = feedback({
      threads: [
        thread("t1", false, [
          comment("h1", "operator", "same login, human"),
          comment("a1", "operator", `Fixed in abc123.\n\n${marker(delivered)}\n`),
        ]),
      ],
    });
    scene.feedback.set(1, answered);
    const quiet = await watch(scene);
    expect(quiet.code).toBe(5);

    const again = await watch(scene, ["--timeout", "120"]);
    expect(again.code).toBe(5);

    scene.feedback.set(
      1,
      feedback({
        threads: [
          thread("t1", false, [
            comment("h1", "operator", "same login, human"),
            comment("a1", "operator", `Fixed in abc123.\n\n${marker(delivered)}\n`),
            comment("h2", "operator", "not quite"),
          ]),
        ],
      })
    );
    const reply = await watch(scene);
    expect(reply.code).toBe(8);
    expect(reply.items.map((item) => item.detail.body)).toEqual(["not quite"]);
  });

  it("ignores a copied marker from another author and a marker that is not last", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "first")] }));
    const first = await watch(scene);
    const delivered = first.items[0]?.id ?? "";
    scene.feedback.set(
      1,
      feedback({
        comments: [
          comment("c1", "alice", "first"),
          comment("c2", "mallory", `looks done\n${marker(delivered)}`),
          comment("c3", "operator", `${marker(delivered)}\nbut one more thing`),
        ],
      })
    );
    const next = await watch(scene);
    expect(next.code).toBe(8);
    expect(next.items.map((item) => item.id)).toContain(delivered);
    expect(next.items.map((item) => item.detail.body)).toEqual([
      "first",
      `looks done\n${marker(delivered)}`,
      `${marker(delivered)}\nbut one more thing`,
    ]);
  });

  it("redelivers unacknowledged items after a rearm", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "hi")] }));
    const first = await watch(scene);
    const second = await watch(scene);
    expect(second.code).toBe(8);
    expect(second.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id)
    );
  });

  it("keeps oversized bodies whole in the batch and bounds the verdict", async () => {
    const scene = world();
    const huge = "x".repeat(40_000);
    scene.feedback.set(
      1,
      feedback({
        comments: Array.from({ length: 30 }, (_, index) =>
          comment(`c${index}`, "alice", huge)
        ),
      })
    );
    const result = await watch(scene);
    const last = result.records.at(-1);
    expect(result.items).toHaveLength(30);
    expect(result.items[0]?.detail.body).toBe(huge);
    expect(last).toMatchObject({ batch: { count: 30 } });
    expect(JSON.stringify(last).length).toBeLessThan(24 * 1024);
  });
});

describe("bot revisions in resolved threads", () => {
  const finding = botComment("d1", "Rename this helper.");
  const answered = comment("d2", "operator", "Renamed in abc123.");
  const addressed = botComment(
    "d1",
    "Rename this helper.\n\n✅ Addressed in commit abc123",
    "2026-01-01T01:00:00Z"
  );
  const offer = botComment("d3", "Would you also like a GitHub issue to track it?");
  const resolved = (...comments: FeedbackComment[]) =>
    thread("t-done", true, comments);

  it("holds a bot's edit and reply in a resolved thread until news wakes the agent", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ threads: [resolved(finding, answered)] }));
    expect((await watch(scene)).code).toBe(5);

    scene.feedback.set(
      1,
      feedback({ threads: [resolved(addressed, answered, offer)] })
    );
    const held = await watch(scene);
    expect(held.code).toBe(5);
    expect(held.records.map((record) => record.kind)).not.toContain("ATTENTION");

    scene.feedback.set(
      1,
      feedback({
        threads: [
          resolved(addressed, answered, offer),
          thread("t-open", false, [comment("o1", "alice", "please fix")]),
        ],
      })
    );
    const news = await watch(scene);
    expect(news.code).toBe(8);
    expect(news.items.map((item) => item.detail.body)).toEqual([
      addressed.body,
      offer.body,
      "please fix",
    ]);
  });

  it("holds bot revisions that arrive while the agent handles a batch", async () => {
    const scene = world();
    scene.feedback.set(
      1,
      feedback({
        comments: [comment("c1", "alice", "please rename")],
        threads: [resolved(finding, answered)],
      })
    );
    const first = await watch(scene);
    expect(first.items.map((item) => item.detail.body)).toEqual(["please rename"]);

    scene.feedback.set(
      1,
      feedback({
        comments: [comment("c1", "alice", "please rename")],
        threads: [resolved(finding, answered, offer)],
      })
    );
    const rearmed = await watch(scene, acks(first.items));
    expect(rearmed.code).toBe(5);

    scene.feedback.set(
      1,
      feedback({
        comments: [
          comment("c1", "alice", "please rename"),
          comment("c2", "alice", "and one more"),
        ],
        threads: [resolved(finding, answered, offer)],
      })
    );
    const news = await watch(scene);
    expect(news.code).toBe(8);
    expect(news.items.map((item) => item.detail.body)).toEqual([
      offer.body,
      "and one more",
    ]);
  });

  it("delivers held bot revisions when the PR merges, then finishes", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ threads: [resolved(finding, answered)] }));
    await watch(scene);
    scene.feedback.set(1, feedback({ threads: [resolved(finding, answered, offer)] }));
    expect((await watch(scene)).code).toBe(5);

    scene.facts.set(1, { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" });
    const merged = await watch(scene);
    expect(merged.code).toBe(8);
    expect(merged.items.map((item) => item.detail.body)).toEqual([offer.body]);
    const done = await watch(scene, acks(merged.items));
    expect(done.code).toBe(0);
    expect(done.records.at(-1)).toMatchObject({ kind: "FINISHED" });
  });

  it("delivers held bot revisions when the PR closes, then finishes", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ threads: [resolved(finding, answered)] }));
    await watch(scene);
    scene.feedback.set(1, feedback({ threads: [resolved(finding, answered, offer)] }));
    expect((await watch(scene)).code).toBe(5);

    scene.facts.set(1, { state: "CLOSED" });
    const closed = await watch(scene);
    expect(closed.code).toBe(8);
    expect(closed.items.map((item) => item.detail.body)).toEqual([offer.body]);
    const done = await watch(scene, acks(closed.items));
    expect(done.code).toBe(0);
    expect(done.records.at(-1)).toMatchObject({ kind: "FINISHED" });
  });

  it("keeps an unacknowledged held revision for the next batch without waking on it", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ threads: [resolved(finding, answered)] }));
    await watch(scene);
    const news = comment("c1", "alice", "please rename");
    scene.feedback.set(
      1,
      feedback({ comments: [news], threads: [resolved(finding, answered, offer)] })
    );
    const batch = await watch(scene);
    expect(batch.items.map((item) => item.detail.body)).toEqual([
      "please rename",
      offer.body,
    ]);

    const newsOnly = batch.items.filter((item) => item.detail.body === news.body);
    const rearmed = await watch(scene, acks(newsOnly));
    expect(rearmed.code).toBe(5);

    scene.feedback.set(
      1,
      feedback({
        comments: [news, comment("c2", "alice", "and one more")],
        threads: [resolved(finding, answered, offer)],
      })
    );
    const next = await watch(scene);
    expect(next.code).toBe(8);
    expect(next.items.map((item) => item.detail.body)).toEqual([
      offer.body,
      "and one more",
    ]);
  });

  it("wakes on a bot's edit or reply in an open thread", async () => {
    const scene = world();
    const open = (...comments: FeedbackComment[]) =>
      thread("t-open", false, comments);
    scene.feedback.set(1, feedback({ threads: [open(finding)] }));
    const first = await watch(scene);
    expect(first.items.map((item) => item.detail.body)).toEqual([finding.body]);

    scene.feedback.set(1, feedback({ threads: [open(addressed, offer)] }));
    const revised = await watch(scene, acks(first.items));
    expect(revised.code).toBe(8);
    expect(revised.items.map((item) => item.detail.body)).toEqual([
      addressed.body,
      offer.body,
    ]);
  });

  it("still delivers items from state written before items could be held", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "hi")] }));
    const first = await watch(scene);
    const path = join(state, "state.json");
    const saved: { items: Record<string, unknown>[] } = JSON.parse(
      readFileSync(path, "utf8")
    );
    for (const item of saved.items) delete item.held;
    writeFileSync(path, JSON.stringify(saved));
    const again = await watch(scene);
    expect(again.code).toBe(8);
    expect(again.items.map((item) => item.id)).toEqual(
      first.items.map((item) => item.id)
    );
  });
});

describe("blockers", () => {
  it("does not rewake for an acknowledged failure, but does for a new head or a recurrence", async () => {
    const scene = world();
    scene.checks.set(1, failing("https://ci/1"));
    const first = await watch(scene);
    expect(first.items.map((item) => item.kind)).toEqual(["merge-blocker"]);
    const quiet = await watch(scene, acks(first.items));
    expect(quiet.code).toBe(5);
    expect(quiet.records).toContainEqual(
      expect.objectContaining({ kind: "MONITORING", condition: "blocked" })
    );

    scene.facts.set(1, { headRefOid: "second" });
    const rehead = await watch(scene);
    expect(rehead.items.map((item) => item.kind)).toEqual(["merge-blocker"]);

    scene.checks.set(1, passing);
    const recovered = await watch(scene, acks(rehead.items));
    expect(recovered.items.map((item) => item.kind)).toEqual([
      "ci-recovered",
      "merge-ready",
    ]);

    scene.checks.set(1, failing("https://ci/1"));
    const recur = await watch(scene, acks(recovered.items));
    expect(recur.items.map((item) => item.kind)).toEqual(["merge-blocker"]);
    expect(recur.items[0]?.id).not.toBe(rehead.items[0]?.id);
  });

  it("reports CI recovered once when failing checks give way to a head with no checks", async () => {
    const scene = world();
    scene.checks.set(1, failing("https://ci/1"));
    const failed = await watch(scene);
    expect(failed.items.map((item) => item.kind)).toEqual(["merge-blocker"]);

    scene.facts.set(1, { headRefOid: "second" });
    scene.checks.set(1, {
      kind: "unusable",
      exitCode: 1,
      stderr: "no checks reported on the 'feature' branch",
    });
    scene.rollups.set(1, { kind: "no-rollup" });
    scene.commitRollups.set(1, [
      { oid: "head", state: "FAILURE" },
      { oid: "second", state: null },
    ]);
    const recovered = await watch(scene, acks(failed.items));
    expect(recovered.items.map((item) => item.kind)).toEqual([
      "ci-recovered",
      "merge-ready",
    ]);

    const quiet = await watch(scene, acks(recovered.items));
    expect(quiet.code).toBe(5);
    expect(quiet.records.map((record) => record.kind)).not.toContain("ATTENTION");
  });

  it("reports a conflict and then waits", async () => {
    const scene = world();
    scene.facts.set(1, { mergeable: "CONFLICTING" });
    const first = await watch(scene);
    expect(first.items[0]?.excerpt).toContain("merge-conflicts");
    expect((await watch(scene, acks(first.items))).code).toBe(5);
  });
});

describe("outages", () => {
  it("reports one CI outage, keeps polling after the ack, wakes on a comment, then on recovery", async () => {
    const scene = world();
    scene.checks.set(1, unavailable);
    const down = await watch(scene, ["--max-query-errors", "2", "--timeout", "600"]);
    expect(down.code).toBe(8);
    expect(down.items.map((item) => [item.kind, item.detail.lane])).toEqual([
      ["status-unavailable", "ci"],
    ]);
    expect(down.records).toContainEqual(expect.objectContaining({ kind: "RETRY" }));

    scene.onSleep = (now) => {
      if (now >= 200)
        scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "ping")] }));
    };
    const comment1 = await watch(scene, [
      "--max-query-errors",
      "2",
      "--timeout",
      "600",
      ...acks(down.items),
    ]);
    expect(comment1.code).toBe(8);
    expect(comment1.items.map((item) => item.kind)).toEqual(["feedback"]);

    scene.onSleep = () => {};
    scene.checks.set(1, pending);
    const back = await watch(scene, acks(comment1.items));
    expect(back.items.map((item) => [item.kind, item.detail.lane])).toEqual([
      ["status-recovered", "ci"],
    ]);
    expect((await watch(scene, acks(back.items))).code).toBe(5);
  });

  it("retries the final read while feedback reads fail, reports it, then finishes", async () => {
    const scene = world();
    expect((await watch(scene)).code).toBe(5);
    scene.feedback.set(1, { kind: "failure", failure: outage });
    scene.facts.set(1, mergedFacts);
    const told = await watch(scene, ["--max-query-errors", "2", "--timeout", "600"]);
    expect(told.records[0]).toMatchObject({ kind: "RETRY" });
    expect(told.code).toBe(8);
    expect(told.items.map((item) => [item.kind, item.detail.lane])).toEqual([
      ["status-unavailable", "feedback"],
    ]);
    const done = await watch(scene, acks(told.items));
    expect(done.code).toBe(0);
    expect(done.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: { kind: "all-merged", merged: [{ context: { number: 1 } }] },
    });
  });

  it(
    "reports a failed final read even when the agent acknowledged an earlier feedback outage",
    async () => {
      const scene = world();
      scene.feedback.set(1, { kind: "failure", failure: outage });
      const down = await watch(scene, ["--max-query-errors", "1"]);
      expect(down.code).toBe(8);
      scene.facts.set(1, mergedFacts);
      const told = await watch(scene, [
        "--max-query-errors",
        "2",
        "--timeout",
        "600",
        ...acks(down.items),
      ]);
      expect(told.records[0]).toMatchObject({ kind: "RETRY" });
      expect(told.code).toBe(8);
      expect(told.items.map((item) => [item.kind, item.detail.lane])).toEqual([
        ["status-unavailable", "feedback"],
      ]);
      expect((await watch(scene, acks(told.items))).code).toBe(0);
    }
  );

  it("reports a final read that fails for good at once, then finishes", async () => {
    const scene = world();
    expect((await watch(scene)).code).toBe(5);
    scene.facts.set(1, mergedFacts);
    scene.feedback.set(1, {
      kind: "failure",
      failure: {
        kind: "invalid-context-url",
        retryable: false,
        detail: "not a pull request URL",
        rawValue: "https://github.com/owner/repo/issues/1",
      },
    });
    const told = await watch(scene);
    expect(told.code).toBe(8);
    expect(told.items.map((item) => [item.kind, item.detail.lane])).toEqual([
      ["status-unavailable", "feedback"],
    ]);
    expect((await watch(scene, acks(told.items))).code).toBe(0);
  });
});

describe("stacks", () => {
  const stack = ["--queued-stack", "--stack-prs", "1,2,3"];

  it("delivers upstack feedback while the frontier is red", async () => {
    const scene = world();
    scene.checks.set(1, failing());
    scene.feedback.set(2, feedback({ comments: [comment("u1", "alice", "upstack")] }));
    const result = await watch(scene, stack);
    expect(result.items.map((item) => [item.pr, item.kind])).toEqual([
      [1, "merge-blocker"],
      [2, "feedback"],
    ]);
  });

  it("ends when a member closes, naming what is still open", async () => {
    const scene = world();
    scene.facts.set(1, { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" });
    scene.facts.set(2, { state: "CLOSED" });
    const result = await watch(scene, stack);
    expect(result.code).toBe(0);
    expect(result.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: {
        kind: "closed",
        closed: [{ number: 2 }],
        merged: [{ context: { number: 1 } }],
        stillOpen: [{ number: 3 }],
      },
    });
  });

  it("accepts dropping merged members and appending, and rejects other edits", async () => {
    const scene = world();
    expect((await watch(scene, stack)).code).toBe(5);
    const reorder = await watch(scene, ["--queued-stack", "--stack-prs", "2,1,3"]);
    expect(reorder.code).toBe(73);
    expect(reorder.stderr).toContain(state);
    const dropOpen = await watch(scene, ["--queued-stack", "--stack-prs", "2,3"]);
    expect(dropOpen.code).toBe(73);

    scene.facts.set(1, { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" });
    const revised = await watch(scene, ["--queued-stack", "--stack-prs", "2,3,4"]);
    expect(revised.code).toBe(5);
    expect(revised.records.at(-1)).toMatchObject({
      scope: [{ number: 2 }, { number: 3 }, { number: 4 }],
    });
  });

  it("keeps the discovered --stack scope on resume", async () => {
    const scene = world();
    scene.open.push(
      { number: parsePrNumber(1), headRefName: "one", baseRefName: "main" },
      { number: parsePrNumber(2), headRefName: "two", baseRefName: "one" }
    );
    expect((await watch(scene, ["--stack"])).records.at(-1)).toMatchObject({
      scope: [{ number: 1 }, { number: 2 }],
    });
    scene.open.splice(0);
    expect((await watch(scene, ["--stack"])).records.at(-1)).toMatchObject({
      scope: [{ number: 1 }, { number: 2 }],
    });
  });
});

describe("state safety", () => {
  it("refuses corrupt state without resetting it", async () => {
    const path = join(state, "state.json");
    writeFileSync(path, "{not json");
    const result = await watch(world());
    expect(result.code).toBe(73);
    expect(result.stderr).toContain(path);
    expect(readFileSync(path, "utf8")).toBe("{not json");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("warns about and ignores an acknowledgement for an item it never delivered", async () => {
    const result = await watch(world(), ["--ack", "a".repeat(64)]);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain(`ignoring --ack ${"a".repeat(64)}`);
  });

  it("refuses a state directory that watches a different PR", async () => {
    const scene = world();
    await watch(scene);
    const other = await watch(scene, ["--pr", "2"]);
    expect(other.code).toBe(73);
  });
});

describe("one watcher per state directory", () => {
  it("refuses a second watcher while the first holds the state, then releases it", async () => {
    const scene = world();
    let entered = (): void => {};
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    scene.beforePullRequest = async () => {
      entered();
      await held;
    };
    const first = watch(scene);
    await reading;
    scene.beforePullRequest = async () => {};
    const second = await watch(scene, ["--ack", "a".repeat(64)]);
    expect(second.code).toBe(73);
    expect(second.stderr).toContain(
      `another watcher owns ${state} (pid ${process.pid})`
    );
    release();
    expect((await first).code).toBe(5);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("reclaims a lock whose watcher died", async () => {
    const dead = spawnSync("true").pid;
    writeFileSync(lockPath(), `${dead} stale-token\n`);
    const result = await watch(world());
    expect(result.code).toBe(5);
    expect(readdirSync(state).filter((name) => name.includes("lock"))).toEqual(
      []
    );
  });
});

describe("delivery before finishing", () => {
  it("delivers unacknowledged feedback after the PR merges, then finishes", async () => {
    const scene = world();
    scene.checks.set(1, passing);
    scene.facts.set(1, { reviewDecision: "REVIEW_REQUIRED" });
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "fix X first")] }));
    const first = await watch(scene);
    expect(first.items.map((item) => item.kind)).toEqual(["feedback", "merge-ready"]);
    scene.facts.set(1, { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" });
    const merged = await watch(
      scene,
      acks(first.items.filter((item) => item.kind === "merge-ready"))
    );
    expect(merged.code).toBe(8);
    expect(merged.items.map((item) => item.detail.body)).toEqual(["fix X first"]);
    const done = await watch(scene, acks(merged.items));
    expect(done.code).toBe(0);
    expect(done.records.at(-1)).toMatchObject({ kind: "FINISHED" });
  });

  it("delivers feedback for open members read in the poll where another member closed", async () => {
    const scene = world();
    scene.facts.set(2, { state: "CLOSED" });
    scene.feedback.set(3, feedback({ comments: [comment("u1", "alice", "upstack")] }));
    const result = await watch(scene, ["--queued-stack", "--stack-prs", "1,2,3"]);
    expect(result.code).toBe(8);
    expect(kinds(result.items)).toEqual([[3, "feedback", "comment by alice"]]);
    const done = await watch(scene, [
      "--queued-stack",
      "--stack-prs",
      "1,2,3",
      ...acks(result.items),
    ]);
    expect(done.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: { kind: "closed", closed: [{ number: 2 }] },
    });
  });

  it("watches a reopened PR again instead of finishing as closed", async () => {
    const scene = world();
    scene.facts.set(1, { state: "CLOSED" });
    expect((await watch(scene)).records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: { kind: "closed" },
    });
    scene.facts.set(1, { state: "OPEN", reviewDecision: "CHANGES_REQUESTED" });
    const reopened = await watch(scene);
    expect(reopened.code).toBe(8);
    expect(kinds(reopened.items)).toEqual([[1, "merge-blocker", "merge-gate on #1"]]);
  });

  it("does not finish on a closed PR whose lifecycle read failed this poll", async () => {
    const scene = world();
    scene.facts.set(1, { state: "CLOSED" });
    expect((await watch(scene)).code).toBe(0);
    scene.beforePullRequest = async () => {
      throw new WatcherQueryError(outage);
    };
    const unread = await watch(scene, ["--max-query-errors", "2", "--timeout", "600"]);
    expect(unread.records[0]).toMatchObject({ kind: "RETRY" });
    expect(unread.code).toBe(8);
    expect(kinds(unread.items)).toEqual([
      [1, "status-unavailable", "lifecycle reads for #1 keep failing"],
    ]);
  });

  it("keeps queued items when the batch file cannot be written, and redelivers them", async () => {
    const scene = world();
    scene.feedback.set(
      1,
      feedback({ threads: [thread("t1", false, [comment("o1", "bob", "bug here")])] })
    );
    writeFileSync(join(state, "batches"), "");
    const failed = await watch(scene);
    expect(failed.code).toBe(73);
    expect(failed.stderr).toContain("cannot write attention batch");
    rmSync(join(state, "batches"));
    scene.feedback.set(
      1,
      feedback({ threads: [thread("t1", true, [comment("o1", "bob", "bug here")])] })
    );
    const retried = await watch(scene);
    expect(retried.code).toBe(8);
    expect(retried.items.map((item) => item.detail.body)).toEqual(["bug here"]);
  });
});

describe("the final read", () => {
  it(
    "delivers a comment posted between the last poll and the merge, then reads no more",
    async () => {
      const scene = world();
      expect((await watch(scene)).code).toBe(5);
      scene.feedback.set(
        1,
        feedback({ comments: [comment("c1", "alice", "please rename X first")] })
      );
      scene.facts.set(1, mergedFacts);
      const last = await watch(scene);
      expect(last.code).toBe(8);
      expect(kinds(last.items)).toEqual([[1, "feedback", "comment by alice"]]);

      scene.feedback.set(
        1,
        feedback({
          comments: [
            comment("c1", "alice", "please rename X first"),
            comment("c2", "alice", "after the merge"),
          ],
        })
      );
      const reads = scene.feedbackReads.length;
      const done = await watch(scene, acks(last.items));
      expect(done.code).toBe(0);
      expect(done.records.at(-1)).toMatchObject({ kind: "FINISHED" });
      expect(scene.feedbackReads.length).toBe(reads);
    }
  );

  it("delivers a comment posted while the agent handles a batch, then the merge", async () => {
    const scene = world();
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "first")] }));
    const first = await watch(scene);
    expect(first.code).toBe(8);
    scene.feedback.set(
      1,
      feedback({
        comments: [
          comment("c1", "alice", "first"),
          comment("c2", "alice", "one more before you merge"),
        ],
      })
    );
    scene.facts.set(1, mergedFacts);
    const last = await watch(scene, acks(first.items));
    expect(last.code).toBe(8);
    expect(last.items.map((item) => item.detail.body)).toEqual(["one more before you merge"]);
    expect((await watch(scene, acks(last.items))).code).toBe(0);
  });

  it("gives a close the same final read as a merge", async () => {
    const scene = world();
    expect((await watch(scene)).code).toBe(5);
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "why close?")] }));
    scene.facts.set(1, { state: "CLOSED" });
    const last = await watch(scene);
    expect(last.code).toBe(8);
    expect(kinds(last.items)).toEqual([[1, "feedback", "comment by alice"]]);
    const done = await watch(scene, acks(last.items));
    expect(done.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: { kind: "closed", closed: [{ number: 1 }] },
    });
  });

  it("reads an upstack member that closes between sweeps", async () => {
    const scene = world();
    const stack = ["--queued-stack", "--stack-prs", "1,2,3"];
    expect((await watch(scene, stack)).code).toBe(5);
    scene.onSleep = (now) => {
      if (now < 20) return;
      scene.facts.set(3, { state: "CLOSED" });
      scene.feedback.set(3, feedback({ comments: [comment("u3", "alice", "last word on 3")] }));
    };
    const last = await watch(scene, stack);
    expect(last.code).toBe(8);
    expect(kinds(last.items)).toEqual([[3, "feedback", "comment by alice"]]);
    scene.onSleep = () => {};
    const done = await watch(scene, [...stack, ...acks(last.items)]);
    expect(done.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: { kind: "closed", closed: [{ number: 3 }] },
    });
  });

  it("retries a failed final read and delivers what it reads once GitHub recovers", async () => {
    const scene = world();
    expect((await watch(scene)).code).toBe(5);
    scene.feedback.set(1, { kind: "failure", failure: outage });
    scene.facts.set(1, mergedFacts);
    scene.onSleep = () => {
      scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "late but real")] }));
    };
    const last = await watch(scene);
    expect(last.records[0]).toMatchObject({ kind: "RETRY" });
    expect(last.code).toBe(8);
    expect(last.items.map((item) => item.detail.body)).toEqual(["late but real"]);
  });

  it(
    "gives the final read to a PR whose feedback was read while its lifecycle read failed",
    async () => {
      const scene = world();
      let lifecycleReads = 0;
      scene.beforePullRequest = async () => {
        lifecycleReads += 1;
        if (lifecycleReads === 1) throw new WatcherQueryError(outage);
      };
      scene.onSleep = () => {
        scene.facts.set(1, mergedFacts);
        scene.feedback.set(
          1,
          feedback({ comments: [comment("c1", "alice", "just before the merge")] })
        );
      };
      const last = await watch(scene);
      expect(last.records[0]).toMatchObject({ kind: "RETRY" });
      expect(last.code).toBe(8);
      expect(last.items.map((item) => item.detail.body)).toEqual(["just before the merge"]);
    }
  );

  it("reads a PR that merged before the first arm", async () => {
    const scene = world();
    scene.facts.set(1, mergedFacts);
    scene.feedback.set(
      1,
      feedback({ comments: [comment("c1", "alice", "before the first poll and the merge")] })
    );
    const last = await watch(scene);
    expect(last.code).toBe(8);
    expect(last.items.map((item) => item.detail.body)).toEqual([
      "before the first poll and the merge",
    ]);
    expect((await watch(scene, acks(last.items))).code).toBe(0);
  });

  it("reads a queued member first seen closed, and every other member that ended", async () => {
    const scene = world();
    const stack = ["--queued-stack", "--stack-prs", "1,2,3"];
    scene.facts.set(1, mergedFacts);
    scene.facts.set(2, { state: "CLOSED" });
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "last word on 1")] }));
    scene.feedback.set(2, feedback({ comments: [comment("c2", "bob", "why close 2?")] }));
    const last = await watch(scene, stack);
    expect(last.code).toBe(8);
    expect(kinds(last.items)).toEqual([
      [1, "feedback", "comment by alice"],
      [2, "feedback", "comment by bob"],
    ]);
    const done = await watch(scene, [...stack, ...acks(last.items)]);
    expect(done.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: {
        kind: "closed",
        closed: [{ number: 2 }],
        merged: [{ context: { number: 1 } }],
        stillOpen: [{ number: 3 }],
      },
    });
  });

  it("reads a member appended to the queue after it merged", async () => {
    const scene = world();
    expect((await watch(scene, ["--queued-stack", "--stack-prs", "1,2"])).code).toBe(5);
    scene.facts.set(3, mergedFacts);
    scene.feedback.set(3, feedback({ comments: [comment("c3", "alice", "last word on 3")] }));
    const last = await watch(scene, ["--queued-stack", "--stack-prs", "1,2,3"]);
    expect(last.code).toBe(8);
    expect(kinds(last.items)).toEqual([[3, "feedback", "comment by alice"]]);
  });

  it("does not read a closed PR again after its final batch", async () => {
    const scene = world();
    expect((await watch(scene)).code).toBe(5);
    scene.facts.set(1, { state: "CLOSED" });
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "before close")] }));
    const final = await watch(scene);
    expect(final.code).toBe(8);
    scene.feedback.set(1, feedback({ comments: [comment("c2", "alice", "after final read")] }));
    const reads = scene.feedbackReads.length;
    expect((await watch(scene, acks(final.items))).code).toBe(0);
    expect(scene.feedbackReads.length).toBe(reads);
  });

  it("keeps a stack open while another member's final read is retrying", async () => {
    const scene = world();
    const stack = ["--queued-stack", "--stack-prs", "1,2"];
    expect((await watch(scene, stack)).code).toBe(5);
    scene.facts.set(1, mergedFacts);
    scene.facts.set(2, { state: "CLOSED" });
    scene.feedback.set(1, { kind: "failure", failure: outage });
    const told = await watch(scene, [...stack, "--max-query-errors", "3", "--timeout", "600"]);
    expect(told.records[0]).toMatchObject({ kind: "RETRY" });
    expect(told.code).toBe(8);
    expect(told.items.map((item) => [item.pr, item.kind, item.detail.lane])).toEqual([
      [1, "status-unavailable", "feedback"],
    ]);
    const done = await watch(scene, [...stack, ...acks(told.items)]);
    expect(done.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: {
        kind: "closed",
        closed: [{ number: 2 }],
        merged: [{ context: { number: 1 } }],
        stillOpen: [],
      },
    });
  });

  it("delivers a retried member's comment after another member closed", async () => {
    const scene = world();
    const stack = ["--queued-stack", "--stack-prs", "1,2"];
    expect((await watch(scene, stack)).code).toBe(5);
    scene.facts.set(1, mergedFacts);
    scene.facts.set(2, { state: "CLOSED" });
    scene.feedback.set(1, { kind: "failure", failure: outage });
    scene.onSleep = () => {
      scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "last word on 1")] }));
    };
    const last = await watch(scene, stack);
    expect(last.records[0]).toMatchObject({ kind: "RETRY" });
    expect(last.code).toBe(8);
    expect(kinds(last.items)).toEqual([[1, "feedback", "comment by alice"]]);
  });

  it("keeps a final read owed through a retry poll whose lifecycle read fails", async () => {
    const scene = world();
    const stack = ["--queued-stack", "--stack-prs", "1,2"];
    expect((await watch(scene, stack)).code).toBe(5);
    scene.facts.set(1, mergedFacts);
    scene.facts.set(2, { state: "CLOSED" });
    scene.feedback.set(1, { kind: "failure", failure: outage });
    let lifecycleReads = 0;
    scene.onSleep = () => {
      scene.beforePullRequest = async () => {
        lifecycleReads += 1;
        if (lifecycleReads === 1) throw new WatcherQueryError(outage);
      };
    };
    const told = await watch(scene, [...stack, "--max-query-errors", "3", "--timeout", "600"]);
    expect(told.code).toBe(8);
    expect(told.items.map((item) => [item.pr, item.kind, item.detail.lane])).toEqual([
      [1, "status-unavailable", "feedback"],
    ]);
  });

  it("resumes an owed final read in the next arm after the watcher exits", async () => {
    const scene = world();
    const stack = ["--queued-stack", "--stack-prs", "1,2"];
    expect((await watch(scene, stack)).code).toBe(5);
    scene.facts.set(1, mergedFacts);
    scene.facts.set(2, { state: "CLOSED" });
    scene.feedback.set(1, { kind: "failure", failure: outage });
    const timedOut = await watch(scene, [...stack, "--max-query-errors", "3", "--timeout", "10"]);
    expect(timedOut.code).toBe(5);
    expect(timedOut.records.at(-1)).toMatchObject({ frontier: { number: 1 } });

    let lifecycleReads = 0;
    scene.beforePullRequest = async () => {
      lifecycleReads += 1;
      if (lifecycleReads === 1) throw new WatcherQueryError(outage);
    };
    const told = await watch(scene, [...stack, "--max-query-errors", "3", "--timeout", "600"]);
    expect(told.code).toBe(8);
    expect(told.items.map((item) => [item.pr, item.kind, item.detail.lane])).toEqual([
      [1, "status-unavailable", "feedback"],
    ]);
    const done = await watch(scene, [...stack, ...acks(told.items)]);
    expect(done.code).toBe(0);
    expect(done.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: {
        kind: "closed",
        closed: [{ number: 2 }],
        merged: [{ context: { number: 1 } }],
        stillOpen: [],
      },
    });
  });

  it(
    "keeps a reopened member's final read owed, so a closed sibling cannot finish the watch before it lands",
    async () => {
      const scene = world();
      const stack = ["--queued-stack", "--stack-prs", "1,2"];
      expect((await watch(scene, stack)).code).toBe(5);
      scene.facts.set(1, { state: "CLOSED" });
      scene.feedback.set(1, { kind: "failure", failure: outage });
      let reopened = false;
      scene.onSleep = () => {
        if (reopened) return;
        reopened = true;
        scene.facts.set(1, { state: "OPEN" });
        scene.facts.set(2, { state: "CLOSED" });
      };
      const told = await watch(scene, [...stack, "--max-query-errors", "3", "--timeout", "600"]);
      expect(told.records.map((record) => record.kind)).toEqual(["RETRY", "RETRY", "ATTENTION"]);
      expect(told.items.map((item) => [item.pr, item.kind, item.detail.lane])).toEqual([
        [1, "status-unavailable", "feedback"],
      ]);
      expect(told.items[0]?.excerpt).toStartWith("the final feedback read for #1 failed");
      const done = await watch(scene, [...stack, ...acks(told.items)]);
      expect(done.code).toBe(0);
      expect(done.records.at(-1)).toMatchObject({
        kind: "FINISHED",
        result: { kind: "closed", closed: [{ number: 2 }], merged: [], stillOpen: [{ number: 1 }] },
      });
    }
  );

  it("retries an owed final read every poll after its non-frontier member reopens", async () => {
    const scene = world();
    const stack = ["--queued-stack", "--stack-prs", "1,2"];
    expect((await watch(scene, stack)).code).toBe(5);
    scene.facts.set(2, { state: "CLOSED" });
    scene.feedback.set(2, { kind: "failure", failure: outage });
    scene.onSleep = () => {
      scene.facts.set(2, { state: "OPEN" });
      scene.feedback.set(2, feedback({ comments: [comment("last", "alice", "before the close")] }));
    };
    const last = await watch(scene, [
      ...stack,
      ...["--sweep-interval", "300", "--timeout", "240", "--max-query-errors", "3"],
    ]);
    expect(last.code).toBe(8);
    expect(last.items.map((item) => [item.pr, item.kind, item.detail.body])).toEqual([
      [2, "feedback", "before the close"],
    ]);
  });

  function rewriteSavedMembers(write: (pr: Record<string, unknown>) => void): void {
    const path = join(state, "state.json");
    const saved: { prs: Record<string, unknown>[] } = JSON.parse(readFileSync(path, "utf8"));
    for (const pr of saved.prs) write(pr);
    writeFileSync(path, JSON.stringify(saved));
  }

  it(
    "treats an ended member as read when state saved no final read, as watchers before it did",
    async () => {
      const scene = world();
      const stack = ["--queued-stack", "--stack-prs", "1,2"];
      scene.facts.set(1, mergedFacts);
      scene.facts.set(2, { state: "CLOSED" });
      scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", "last word on 1")] }));
      const last = await watch(scene, stack);
      expect(last.code).toBe(8);
      rewriteSavedMembers((pr) => {
        delete pr.finalRead;
      });
      const reads = scene.feedbackReads.length;
      const done = await watch(scene, [...stack, ...acks(last.items)]);
      expect(done.records.at(-1)).toMatchObject({
        kind: "FINISHED",
        result: { kind: "closed", closed: [{ number: 2 }], merged: [{ context: { number: 1 } }] },
      });
      expect(scene.feedbackReads.length).toBe(reads);
    }
  );

  it("refuses state whose final read is neither owed nor done", async () => {
    const scene = world();
    scene.facts.set(1, mergedFacts);
    expect((await watch(scene)).code).toBe(0);
    rewriteSavedMembers((pr) => {
      pr.finalRead = "maybe";
    });
    const refused = await watch(scene);
    expect(refused.code).toBe(73);
    expect(refused.stderr).toContain("state.prs[0].finalRead");
  });
});

describe("own replies", () => {
  it(
    "skips the viewer's reply that ends in the own-reply marker and acknowledges nothing",
    async () => {
      const scene = world();
      const finding = comment("b1", "cursor", "possible null deref");
      scene.feedback.set(1, feedback({ threads: [thread("t1", false, [finding])] }));
      const first = await watch(scene);
      expect(first.code).toBe(8);
      const reply = comment("r1", "operator", `Fixed in abc123.\n\n${ownReply}`);
      scene.feedback.set(1, feedback({ threads: [thread("t1", false, [finding, reply])] }));

      const redelivered = await watch(scene);
      expect(redelivered.code).toBe(8);
      expect(redelivered.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));

      const quiet = await watch(scene, acks(first.items));
      expect(quiet.code).toBe(5);
    }
  );

  it(
    "acknowledges only the item a reply lists when it also ends in the own-reply marker",
    async () => {
      const scene = world();
      const first = comment("c1", "alice", "first");
      const second = comment("c2", "bob", "second");
      scene.feedback.set(1, feedback({ comments: [first, second] }));
      const both = await watch(scene);
      const firstId = both.items.find((item) => item.detail.body === "first")?.id ?? "";
      const reply = comment("r1", "operator", `Fixed\n${marker(firstId)}\n${ownReply}`);
      scene.feedback.set(1, feedback({ comments: [first, second, reply] }));
      const rest = await watch(scene);
      expect(rest.code).toBe(8);
      expect(rest.items.map((item) => item.detail.body)).toEqual(["second"]);
    }
  );

  it("treats the marker from another author as that author's comment", async () => {
    const scene = world();
    expect((await watch(scene)).code).toBe(5);
    scene.feedback.set(1, feedback({ comments: [comment("c1", "alice", `copied\n${ownReply}`)] }));
    const woke = await watch(scene);
    expect(kinds(woke.items)).toEqual([[1, "feedback", "comment by alice"]]);
  });
});

describe("blockers come from the lane that read them", () => {
  it("reports a conflict and a draft gate while CI reads are down", async () => {
    const scene = world();
    scene.checks.set(1, unavailable);
    const down = await watch(scene, ["--max-query-errors", "1"]);
    expect(kinds(down.items)).toEqual([[1, "status-unavailable", "ci reads for #1 keep failing"]]);
    scene.facts.set(1, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", isDraft: true });
    const blocked = await watch(scene, ["--max-query-errors", "1", ...acks(down.items)]);
    expect(blocked.code).toBe(8);
    expect(kinds(blocked.items)).toEqual([
      [1, "merge-blocker", "merge-conflicts on #1"],
      [1, "merge-blocker", "merge-gate on #1"],
    ]);
  });

  it("sees an upstack conflict on the next poll, before the sweep", async () => {
    const scene = world();
    scene.onSleep = (now) => {
      if (now >= 20) scene.facts.set(2, { mergeable: "CONFLICTING" });
    };
    const result = await watch(scene, ["--queued-stack", "--stack-prs", "1,2"]);
    expect(result.code).toBe(8);
    expect(kinds(result.items)).toEqual([[2, "merge-blocker", "merge-conflicts on #2"]]);
  });

  it("reads upstack feedback at the sweep interval and the frontier's every poll", async () => {
    const scene = world();
    await watch(scene, ["--queued-stack", "--stack-prs", "1,2", "--sweep-interval", "30"]);
    const reads = (pr: number) => scene.feedbackReads.filter((read) => read === pr).length;
    expect([reads(1), reads(2)]).toEqual([7, 3]);
  });
});

describe("non-observations do not flap", () => {
  it("wakes once while GitHub alternates CONFLICTING and UNKNOWN on one head", async () => {
    const scene = world();
    scene.checks.set(1, passing);
    const conflicting = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } as const;
    const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } as const;
    const wakes: string[][] = [];
    let ack: string[] = [];
    for (const facts of [conflicting, unknown, conflicting, unknown, conflicting]) {
      scene.facts.set(1, facts);
      const result = await watch(scene, ack);
      wakes.push(result.items.map((item) => item.excerpt));
      ack = acks(result.items);
    }
    expect(wakes).toEqual([["merge-conflicts on #1: CONFLICTING; DIRTY"], [], [], [], []]);
  });

  it("wakes once for a draft whose CI reruns on the same head", async () => {
    const scene = world();
    scene.checks.set(1, passing);
    scene.facts.set(1, { isDraft: true });
    const first = await watch(scene);
    expect(kinds(first.items)).toEqual([[1, "merge-blocker", "merge-gate on #1"]]);
    scene.onSleep = (now) => {
      if (now === 10) scene.checks.set(1, pending);
      if (now === 20) scene.checks.set(1, passing);
    };
    const rerun = await watch(scene, acks(first.items));
    expect(rerun.code).toBe(5);
  });
});
