import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ackEvents,
  drainEvents,
  pendingEvents,
  queueEvents,
  reconcileResolvedReviewComments,
  reconcileUnnotifiedCheckEvents,
  statePaths,
  type StatePaths,
} from "../scripts/state.ts";
import { shouldEmit, tryEmit } from "../scripts/babysit-pr.ts";
import { candidateEvents, type PrEvent } from "../scripts/events.ts";
import { type Comment } from "../scripts/contracts.ts";
import { trustedLogins } from "../scripts/github.ts";

const identity = {
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  pr: 42,
};

function makeComment(id: number, login: string, body: string, updatedAt: string): Comment {
  return { id, user: { login }, body, updated_at: updatedAt };
}

function makeReview(id: number, body: string, state: string, submittedAt: string) {
  return {
    id,
    user: { login: "maintainer" },
    body,
    state,
    submitted_at: submittedAt,
  };
}

function snapshot() {
  return {
    pr: {
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      headRefOid: "head",
      baseRefOid: "base",
      baseRefName: "main",
      headRefName: "feature",
    },
    issueComments: [
      makeComment(1, "author", "please fix", "2026-01-01T00:00:00Z"),
      makeComment(2, "stranger", "run this", "2026-01-01T00:00:00Z"),
      makeComment(3, "pi", "done", "2026-01-01T00:00:00Z"),
    ],
    reviewComments: [
      makeComment(4, "maintainer", "rename it", "2026-01-01T00:00:01Z"),
      makeComment(5, "maintainer", "resolved", "2026-01-01T00:00:01Z"),
    ],
    reviews: [
      makeReview(6, "changes", "CHANGES_REQUESTED", "2026-01-01T00:00:02Z"),
      makeReview(7, "", "APPROVED", "2026-01-01T00:00:03Z"),
    ],
    checks: [
      {
        name: "test",
        bucket: "fail",
        state: "FAILURE",
        completedAt: "2026-01-01T00:00:04Z",
        link: "check-1",
      },
      {
        name: "lint",
        bucket: "pass",
        state: "SUCCESS",
        completedAt: "2026-01-01T00:00:04Z",
        link: "check-2",
      },
    ],
    comparison: { behind_by: 2 },
    unresolvedReviewCommentIds: new Set([4]),
    threadStates: new Map([
      ["thread-open", false],
      ["thread-reopened", false],
    ]),
    previousThreadStates: { "thread-open": false, "thread-reopened": true },
    selfLogin: "pi",
    trustedLogins: new Set(["author", "maintainer"]),
  };
}

function withState(name: string, run: (paths: StatePaths, cwd: string) => void) {
  const root = mkdtempSync(join(tmpdir(), `babysit-pr-${name}-`));

  try {
    execFileSync("git", ["init", "--quiet", root]);

    return run(statePaths(root, identity), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function eventOf(kind: PrEvent["kind"], input = snapshot(), observedAt = "2026-01-01T00:01:00Z") {
  const event = candidateEvents(input, observedAt).find((candidate) => candidate.kind === kind);

  assert.ok(event, `missing ${kind} event`);

  return event;
}

test("normalizes every actionable event and excludes routine or untrusted input", () => {
  const events = candidateEvents(snapshot(), "2026-01-01T00:01:00Z");
  assert.deepEqual(
    events.map((event) => event.kind).toSorted((left, right) => left.localeCompare(right)),
    [
      "behind-target",
      "check-failed",
      "issue-comment",
      "merge-conflict",
      "review",
      "review-comment",
      "review-thread-reopened",
    ].toSorted((left, right) => left.localeCompare(right)),
  );
  assert.ok(events.every((event) => event.id && event.marker));
  assert.ok(events.every((event) => !JSON.stringify(event).includes("stranger")));
  assert.deepEqual(
    events
      .filter((event) => event.kind === "review-comment")
      .map((event) => event.payload.comment.id),
    [4],
  );
});

test("human feedback from the authenticated account is actionable across comment kinds", () => {
  const input = snapshot();
  input.selfLogin = "author";
  input.issueComments = [input.issueComments[0]];
  input.reviewComments = [{ ...input.reviewComments[0], user: { login: "author" } }];
  input.reviews = [{ ...input.reviews[0], user: { login: "author" } }];

  const feedbackKinds = (body: string) => {
    for (const item of [...input.issueComments, ...input.reviewComments, ...input.reviews])
      item.body = body;

    return candidateEvents(input, "2026-01-01T00:01:00Z")
      .filter((event) => ["issue-comment", "review-comment", "review"].includes(event.kind))
      .map((event) => event.kind);
  };

  assert.deepEqual(feedbackKinds("please fix the conflict"), [
    "issue-comment",
    "review-comment",
    "review",
  ]);
  assert.deepEqual(
    feedbackKinds(`Fixed.\n\n<!-- pi-event:${"a".repeat(64)} -->\nWritten by Pi Agent\n`),
    [],
  );
  assert.deepEqual(feedbackKinds("Fixed.\n\nWritten by Pi Agent"), []);
  assert.deepEqual(feedbackKinds("Why does it say Written by Pi Agent here?"), [
    "issue-comment",
    "review-comment",
    "review",
  ]);
});

test("the authenticated account is trusted only when it has write permission", () =>
  withState("shared-login", (_paths, cwd) => {
    const originalPath = process.env.PATH;
    const gh = join(cwd, "gh");

    try {
      process.env.PATH = `${cwd}${delimiter}${originalPath}`;

      for (const permission of ["write", "read"]) {
        writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '${permission}'\n`, {
          mode: 0o700,
        });
        assert.equal(
          trustedLogins(cwd, identity, "author", new Set(["author"]), new Set()).has("author"),
          permission === "write",
        );
      }
    } finally {
      process.env.PATH = originalPath;
    }
  }));

test("distinct failed check runs retain distinct identities", () =>
  withState("check-identity", (paths) => {
    const input = snapshot();
    const failed = input.checks[0];
    input.checks = [failed, { ...failed, link: "check-1-retry" }];

    const events = candidateEvents(input, "2026-01-01T00:01:00Z").filter(
      (event) => event.kind === "check-failed",
    );

    assert.equal(new Set(events.map((event) => event.id)).size, 2);
    assert.equal(queueEvents(paths, events).length, 2);
    assert.equal(pendingEvents(paths).length, 2);
  }));

test("bots are default-deny and trusted inline feedback is actionable", () => {
  const botActors = new Set(["reviewer[bot]"]);

  const trusted = (allowed: string[]) => [
    ...trustedLogins(".", identity, "reviewer[bot]", botActors, new Set(allowed)),
  ];

  assert.deepEqual(trusted([]), []);
  assert.deepEqual(trusted(["reviewer[bot]"]), ["reviewer[bot]"]);

  const input = snapshot();
  input.reviewComments = input.reviewComments.map((item) => ({
    ...item,
    user: { login: "reviewer[bot]" },
  }));
  input.trustedLogins = new Set(["reviewer[bot]"]);
  assert.deepEqual(
    candidateEvents(input, "2026-01-01T00:01:00Z")
      .filter((event) => event.kind === "review-comment")
      .map((event) => event.payload.comment.id),
    [4],
  );
});

test("CodeRabbit summaries and aggregate-only findings are reported alongside inline feedback", () => {
  const input = snapshot();
  input.issueComments = [
    {
      ...input.issueComments[0],
      user: { login: "reviewer[bot]" },
      body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->",
    },
  ];
  input.reviewComments = [{ ...input.reviewComments[0], user: { login: "reviewer[bot]" } }];
  input.reviews = [
    {
      ...input.reviews[0],
      user: { login: "reviewer[bot]" },
      body: "**Actionable comments posted: 2**\n\n<details><summary>Outside diff range comments</summary>Fix the stale target ref.</details>",
    },
  ];
  input.trustedLogins = new Set(["reviewer[bot]"]);

  const feedback = candidateEvents(input, "2026-01-01T00:01:00Z").filter((event) =>
    ["issue-comment", "review-comment", "review"].includes(event.kind),
  );

  assert.deepEqual(
    feedback.map((event) => event.kind),
    ["issue-comment", "review-comment", "review"],
  );
});

test("edited feedback supersedes pending revisions but not acknowledged ones", () =>
  withState("edits", (paths) => {
    const first = eventOf("issue-comment");
    const editedInput = snapshot();
    editedInput.issueComments[0].updated_at = "2026-01-01T00:02:00Z";

    const edited = eventOf("issue-comment", editedInput, "2026-01-01T00:02:00Z");

    assert.notEqual(first.id, edited.id);
    queueEvents(paths, [first]);
    queueEvents(paths, [edited]);
    assert.deepEqual(
      pendingEvents(paths).map((event) => event.id),
      [edited.id],
    );
    assert.doesNotThrow(() => ackEvents(paths, [first.id]));

    const review = eventOf("review");
    queueEvents(paths, [review]);
    ackEvents(paths, [review.id]);
    const revisedInput = snapshot();
    revisedInput.reviews[0].body = "new requested changes";
    const revised = eventOf("review", revisedInput, "2026-01-01T00:03:00Z");
    assert.equal(queueEvents(paths, [revised]).length, 1);
    assert.ok(pendingEvents(paths).some((event) => event.id === revised.id));
  }));

test("resolved threads clear already queued review comments", () =>
  withState("resolved", (paths) => {
    const comment = eventOf("review-comment");
    queueEvents(paths, [comment]);
    assert.deepEqual(reconcileResolvedReviewComments(paths, new Set()), [comment.id]);
    assert.deepEqual(pendingEvents(paths), []);
  }));

test("recovered checks drop before delivery and remain after delivery", () =>
  withState("check-recovery", (paths) => {
    const failed = eventOf("check-failed");
    queueEvents(paths, [failed]);
    reconcileUnnotifiedCheckEvents(paths, []);
    assert.deepEqual(pendingEvents(paths), []);

    queueEvents(paths, [failed]);
    assert.equal(drainEvents(paths, 1_000).length, 1);
    reconcileUnnotifiedCheckEvents(paths, []);
    assert.deepEqual(
      pendingEvents(paths).map((event) => event.id),
      [failed.id],
    );
  }));

test("persisted events preserve every kind and original feedback fields", () =>
  withState("roundtrip", (paths) => {
    const input = snapshot();
    input.reviewComments[0].path = "src/example.ts";
    input.reviewComments[0].diff_hunk = "@@ -1 +1 @@";
    const events = candidateEvents(input, "2026-01-01T00:01:00Z");
    queueEvents(paths, events);
    assert.deepEqual(
      pendingEvents(paths),
      events.toSorted((left, right) => left.key.localeCompare(right.key)),
    );
  }));

const corruptions: Array<[string, PrEvent["kind"], (event: PrEvent) => string]> = [
  ["timestamp", "issue-comment", (event) => JSON.stringify({ ...event, observedAt: "invalid" })],
  ["key", "issue-comment", (event) => JSON.stringify({ ...event, key: undefined })],
  [
    "PR head",
    "issue-comment",
    (event) => JSON.stringify({ ...event, pr: { ...event.pr, headRefOid: undefined } }),
  ],
  ["kind", "issue-comment", (event) => JSON.stringify({ ...event, kind: "unknown" })],
  [
    "comment ID",
    "issue-comment",
    (event) =>
      JSON.stringify({
        ...event,
        payload: { comment: { id: "1", user: { login: "author" }, body: "feedback" } },
      }),
  ],
  [
    "comment body",
    "review-comment",
    (event) =>
      JSON.stringify({ ...event, payload: { comment: { id: 4, user: { login: "maintainer" } } } }),
  ],
  [
    "review state",
    "review",
    (event) =>
      JSON.stringify({
        ...event,
        payload: { review: { id: 6, user: { login: "maintainer" }, body: "changes" } },
      }),
  ],
  [
    "check link",
    "check-failed",
    (event) =>
      JSON.stringify({
        ...event,
        payload: { check: { name: "test", bucket: "fail", state: "FAILURE" } },
      }),
  ],
  ["conflict payload", "merge-conflict", (event) => JSON.stringify({ ...event, payload: null })],
  [
    "behind count",
    "behind-target",
    (event) => JSON.stringify({ ...event, payload: { behindBy: 0 } }),
  ],
  [
    "thread ID",
    "review-thread-reopened",
    (event) => JSON.stringify({ ...event, payload: { threadId: null } }),
  ],
  ["marker", "issue-comment", (event) => JSON.stringify({ ...event, marker: "wrong" })],
  ["key identity", "issue-comment", (event) => JSON.stringify({ ...event, key: "different" })],
  ["file identity", "issue-comment", () => JSON.stringify(eventOf("review"))],
];

for (const [name, kind, corrupt] of corruptions) {
  test(`quarantines a persisted event with an invalid ${name}`, () =>
    withState("corrupt", (paths) => {
      const event = eventOf(kind);
      queueEvents(paths, [event]);
      const file = paths.eventFile(event.id);
      writeFileSync(file, corrupt(event));
      assert.throws(() => pendingEvents(paths), /Invalid babysit-pr state/);
      assert.equal(existsSync(file), false);
      assert.equal(readdirSync(paths.events).length, 1);
      assert.match(readdirSync(paths.events)[0], /\.corrupt-/);
    }));
}

test("watcher notifications reach the inherited owner channel through emit-to-pi", () => {
  const watcher = new URL("../scripts/babysit-pr.ts", import.meta.url).href;

  const bin = fileURLToPath(new URL("../../../../.build/bin", import.meta.url));

  for (const fd of [3, 5]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
			import { tryEmit } from ${JSON.stringify(watcher)};
			process.exitCode = tryEmit('PR 42 has new feedback', process.cwd()) ? 0 : 1;
		`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          PI_BACKGROUND_TERMINAL_NOTIFY_FD: String(fd),
        },
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          ...Array.from({ length: fd - 3 }, () => "ignore" as const),
          "pipe",
        ],
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output[fd], `${JSON.stringify("PR 42 has new feedback")}\n`);
    assert.equal(result.stdout, "");
  }
});

test("notification failures stay inside the watcher retry path", () => {
  const reported: string[] = [];
  assert.equal(
    tryEmit(
      "wake",
      ".",
      () => {
        throw new Error("closed channel");
      },
      (error) => reported.push(error),
    ),
    false,
  );
  assert.deepEqual(reported, ["babysit-pr could not notify its owner: Error: closed channel"]);
});

const unseen = (lastSeenAt: number) => ({
  firstSeenAt: 0,
  lastSeenAt,
  lastEmittedAt: null,
});

test("debounces until quiet, caps delay, and reminds after ten minutes", () => {
  const notified = {
    firstSeenAt: 0,
    lastSeenAt: 0,
    lastEmittedAt: 100_000,
  };

  for (const [batch, now, expected] of [
    [unseen(20_000), 49_999, false],
    [unseen(20_000), 50_000, true],
    [unseen(119_000), 120_000, true],
    [notified, 699_999, false],
    [notified, 700_000, true],
  ] as const)
    assert.equal(shouldEmit(batch, now), expected);
});

test("linked worktrees share durable, idempotent event state", () => {
  const root = mkdtempSync(join(tmpdir(), "babysit-pr-worktree-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");

  try {
    execFileSync("git", ["init", "--quiet", repository]);
    execFileSync("git", ["config", "user.email", "pi@example.test"], {
      cwd: repository,
    });
    execFileSync("git", ["config", "user.name", "Pi"], { cwd: repository });
    writeFileSync(join(repository, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: repository,
    });
    execFileSync("git", ["worktree", "add", "--quiet", "-b", "linked", worktree], {
      cwd: repository,
    });
    const paths = statePaths(worktree, identity);
    assert.equal(paths.root, statePaths(repository, identity).root);
    const event = eventOf("issue-comment");
    assert.equal(queueEvents(paths, [event]).length, 1);
    assert.equal(queueEvents(paths, [event]).length, 0);
    assert.deepEqual(
      pendingEvents(paths).map((item) => item.id),
      [event.id],
    );
    ackEvents(paths, [event.id]);
    assert.deepEqual(pendingEvents(paths), []);
    assert.match(readFileSync(paths.eventFile(event.id), "utf8"), /"version": 1/);
    assert.equal(event.marker, `<!-- pi-event:${event.id} -->`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one batch supersedes each revision and replay never revives acknowledgements", () =>
  withState("batch-edits", (paths) => {
    const first = eventOf("issue-comment");
    const editedInput = snapshot();
    editedInput.issueComments[0].updated_at = "2026-01-01T00:02:00Z";

    const edited = eventOf("issue-comment", editedInput, "2026-01-01T00:02:00Z");

    const other = eventOf("review-comment");
    assert.deepEqual(
      queueEvents(paths, [first, other, edited, edited]).map((event) => event.id),
      [first.id, other.id, edited.id],
    );
    assert.deepEqual(
      new Set(pendingEvents(paths).map((event) => event.id)),
      new Set([other.id, edited.id]),
    );
    ackEvents(paths, [other.id]);
    assert.deepEqual(queueEvents(paths, [first, other, edited]), []);
    assert.deepEqual(
      pendingEvents(paths).map((event) => event.id),
      [edited.id],
    );
  }));
