import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { WatcherQueryError } from "./github.ts";
import {
  emptyFeedback,
  failedCheck,
  fakeReader,
  passingCheck,
  pendingCheck,
  type FeedbackFrame,
} from "./fakes.test-helper.ts";
import type {
  ChecksFastPath,
  FeedbackComment,
  FeedbackSnapshot,
  FeedbackThread,
  GitHubReader,
  OpenPullRequest,
  PrContext,
  PullRequestFacts,
  QueryFailure,
  SubmittedReview,
  SubmittedReviewState,
} from "./types.ts";
import { parsePrNumber } from "./types.ts";

interface World {
  readonly facts: Map<number, Partial<Omit<PullRequestFacts, "context">>>;
  readonly checks: Map<number, ChecksFastPath>;
  readonly feedback: Map<number, FeedbackFrame>;
  readonly open: OpenPullRequest[];
  onSleep: (now: number) => void;
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
    feedback: new Map(),
    open: [],
    onSleep: () => {},
  };
}
function readerFor(scene: World): GitHubReader {
  const base = fakeReader({ openPullRequests: scene.open });
  return {
    ...base,
    async pullRequest(context: PrContext) {
      const facts = await base.pullRequest(context);
      return { ...facts, ...scene.facts.get(context.number), context };
    },
    async checksFastPath(context: PrContext) {
      return scene.checks.get(context.number) ?? pending;
    },
    async feedback(context: PrContext) {
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
    }
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

  it("still finishes on merge while feedback reads fail", async () => {
    const scene = world();
    scene.feedback.set(1, { kind: "failure", failure: outage });
    scene.facts.set(1, { state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" });
    const result = await watch(scene);
    expect(result.code).toBe(0);
    expect(result.records.at(-1)).toMatchObject({
      kind: "FINISHED",
      result: { kind: "all-merged", merged: [{ context: { number: 1 } }] },
    });
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
  });

  it("rejects an acknowledgement for an item it never delivered", async () => {
    const result = await watch(world(), ["--ack", "a".repeat(64)]);
    expect(result.code).toBe(73);
  });

  it("refuses a state directory that watches a different PR", async () => {
    const scene = world();
    await watch(scene);
    const other = await watch(scene, ["--pr", "2"]);
    expect(other.code).toBe(73);
  });
});
