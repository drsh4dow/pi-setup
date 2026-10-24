// The scripted user: what it replies to each kind of stop, and which PRs it takes as merge-ready.

import assert from "node:assert/strict";
import { describe, test, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChunkScope, chunkFinalPrs } from "../drive.ts";
import { writeGitHub } from "../fakegh.ts";
import { initialFakeGitHub, type PullRequest } from "../gh-state.ts";
import {
  answerSheet,
  asksQuestion,
  BEYOND_CHUNK_REPLY,
  decide,
  mergeReadyClaims,
  type TurnEnd,
} from "../user.ts";

const sheet = { owner: "acme", repo: "tally-x", port: 4321 };

function turn(overrides: Partial<TurnEnd>): TurnEnd {
  return {
    text: "",
    intakeAnswered: true,
    mergedNow: [],
    openFinalPrs: 1,
    mergedFinalPrs: 0,
    beyondChunkDeclined: false,
    sheet,
    ...overrides,
  };
}

describe("the scripted user", () => {
  test("answers the first stop with the answer sheet, even when no question mark ends a line", () => {
    const text =
      "1. **Base branch.** Is it `main`? Default: `main`.\n2. **Deploy signal.** Default: `/version`.";

    const decision = decide(turn({ text, intakeAnswered: false }));

    assert.deepEqual(decision, { kind: "reply", reason: "intake", text: answerSheet(sheet) });
  });

  test("the answer sheet pins every intake fact the prompt asks for, and keeps the final merge", () => {
    const text = answerSheet(sheet);

    for (const fact of [
      "Base branch: `main`",
      "http://127.0.0.1:4321",
      "/version",
      "Publication",
      "Merging a final PR into `main` is mine",
    ]) {
      assert.ok(text.includes(fact), fact);
    }
  });

  test("a question mark inside code or a URL is not a question", () => {
    assert.equal(
      asksQuestion("Probe with `curl -s 'http://h/convert?from=m'` and see http://h/x?y=1."),
      false,
    );
    assert.equal(asksQuestion("Shall I split the final PR?"), true);
  });

  test("re-asking an intake fact after the intake gets the answer sheet again, counted as a re-ask", () => {
    const decision = decide(
      turn({
        text: "Status: two PRs open. What URL reaches the deployed service, and what is the deploy signal?",
      }),
    );

    assert.equal(decision.kind === "reply" && decision.reason, "re-ask");
  });

  test("any other question gets the proposed default", () => {
    const decision = decide(turn({ text: "Should TAL-4's rationale go in docs/decisions.md?" }));

    assert.deepEqual(decision, {
      kind: "reply",
      reason: "default",
      text: "Use your proposed default, and carry on.",
    });
  });

  test("a status report without a question gets a nudge, counted as a status request", () => {
    const decision = decide(
      turn({ text: "TAL-2 merged into the integration branch. TAL-3 is in flight." }),
    );

    assert.equal(decision.kind === "reply" && decision.reason, "nudge");
  });

  test("reports a merge it made before anything else", () => {
    const decision = decide(turn({ text: "Waiting for you to merge #7.", mergedNow: [7] }));

    assert.equal(decision.kind === "reply" && decision.reason, "merged");
    assert.match(decision.kind === "reply" ? decision.text : "", /#7/);
  });

  test("stops once every final PR is merged and the orchestrator asks nothing", () => {
    const decision = decide(
      turn({ text: "Verified live. Closed TAL-1.", openFinalPrs: 0, mergedFinalPrs: 1 }),
    );

    assert.equal(decision.kind, "stop");
  });

  // Close reports of the contaminated batch, whose user accepted these and got a second final PR.
  const proposals = [
    "Everything is in the state folder.\n\nOne decision is still open: **should I change standing order 14 in the implement-chunk prompt?** I propose: keep ticket keys out of intermediate PRs entirely.",
    "4. **Should I add the general rules from this run to the repo's agent files as a small docs PR?**",
    "**Open asks:** 1. Should I make the edits to `AGENTS.md`, `docs/agents/issue-tracker.md` and the prompt? 2. Should any of the five follow-ups become tickets?",
  ];

  test("after the chunk's final PRs merged, declines a proposal beyond the chunk once, counted apart", () => {
    for (const text of proposals) {
      assert.deepEqual(decide(turn({ text, openFinalPrs: 0, mergedFinalPrs: 1 })), {
        kind: "reply",
        reason: "beyond-chunk",
        text: BEYOND_CHUNK_REPLY,
      });
    }
  });

  test("stops when the orchestrator proposes beyond the chunk again after the decline", () => {
    const decision = decide(
      turn({ text: proposals[0], openFinalPrs: 0, mergedFinalPrs: 1, beyondChunkDeclined: true }),
    );

    assert.equal(decision.kind, "stop");
  });

  test("still answers an in-chunk question after the close with the proposed default", () => {
    const decision = decide(
      turn({
        text: "Live check passed. Should I delete the merged integration branch?",
        openFinalPrs: 0,
        mergedFinalPrs: 1,
      }),
    );

    assert.equal(decision.kind === "reply" && decision.reason, "default");
  });

  test("before the chunk closes, a question naming a follow-up gets the proposed default", () => {
    const decision = decide(turn({ text: "Should the rounding gap become a follow-up?" }));

    assert.equal(decision.kind === "reply" && decision.reason, "default");
  });

  test("takes as merge-ready only the PRs a sentence says are ready now", () => {
    const text =
      "Opened #3 into the integration branch.\n\nThe final PR #9 is merge-ready: CI green, review threads resolved.\n\n- #4 still has a failing check.";

    assert.deepEqual(
      mergeReadyClaims(text).map((claim) => claim.pr),
      [9],
    );
  });

  test("a plan to reach merge-ready is not a claim", () => {
    // The first two sentences made the smoke run's user merge both final PRs early.
    const plans = [
      "A PR writer (bt-27) is fixing those passages. The babysitter (bt-25) is still driving #5 to merge-ready.",
      "- **Babysitter (bt-12) on #8:** checking that claim, replying with the disproof and resolving the thread, then confirming merge-ready.",
      "- a babysitter (bt-25), taking #5 to merge-ready in drive mode;",
      "#6 is not merge-ready yet: one thread is open.",
      "I'll tell you when #7 is ready to merge.",
    ];

    assert.deepEqual(plans.flatMap(mergeReadyClaims), []);
  });

  test("a claim without a PR number in its sentence takes the number from its paragraph", () => {
    const text =
      "Final PR #12 has green CI and every thread resolved. It is now merge-ready, and merging is yours.";

    assert.deepEqual(
      mergeReadyClaims(text).map((claim) => claim.pr),
      [12],
    );
  });
});

const scratch = mkdtempSync(join(tmpdir(), "ic-scope-test-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

function pr(number: number, headRefName: string, state: PullRequest["state"]): PullRequest {
  return {
    number,
    title: "t",
    body: "",
    author: "sam-rivera",
    headRefName,
    baseRefName: "main",
    headRefOid: "0",
    state,
    isDraft: false,
    createdAt: "2026-10-24T10:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    mergeCommit: null,
    heads: [],
    comments: [],
  };
}

// candidate t2's plan.md before the close, and the section it added after.
const PLAN =
  "## Final PRs\nF1: all of TAL-2, TAL-3, TAL-4. Integration branch chunk/TAL-1/length-conversion -> main.\n";

const FOLLOW_ON =
  "## F2 (follow-on): agent docs\nIntegration branch: chunk/TAL-1/agent-docs -> main.\nFinal PR F2: #8\n";

describe("the chunk's final PRs", () => {
  test("are the PRs into main the plan names by head branch or number", () => {
    const prs = [
      pr(5, "chunk/TAL-1/length-conversion", "OPEN"),
      pr(8, "chunk/TAL-1/agent-docs", "OPEN"),
    ];

    assert.deepEqual(chunkFinalPrs(prs, PLAN), { numbers: [5], source: "plan.md" });
    assert.deepEqual(chunkFinalPrs(prs, "no branch named"), {
      numbers: [5, 8],
      source: "every PR into main",
    });
  });

  test("freeze once they have all merged, so a PR opened after the close keeps no run going", () => {
    const ghState = join(scratch, "gh-state.json");
    const stateDir = join(scratch, "state");
    const planDir = join(stateDir, "pi-agent", "tally", "implement-chunk", "TAL-1");

    const github = initialFakeGitHub({
      owner: "acme",
      repo: "tally",
      bare: "/b",
      ciDelayMs: 0,
      botDelayMs: 0,
    });

    const scope = new ChunkScope({ ghState, stateDir });

    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "plan.md"), PLAN);
    writeGitHub(ghState, { ...github, prs: [pr(5, "chunk/TAL-1/length-conversion", "OPEN")] });

    assert.deepEqual([scope.observe().open, scope.closed], [[5], false]);

    writeGitHub(ghState, { ...github, prs: [pr(5, "chunk/TAL-1/length-conversion", "MERGED")] });

    assert.equal(scope.observe().merged, 1);
    assert.equal(scope.closed, true);

    writeFileSync(join(planDir, "plan.md"), PLAN + FOLLOW_ON);
    writeGitHub(ghState, {
      ...github,
      prs: [
        pr(5, "chunk/TAL-1/length-conversion", "MERGED"),
        pr(8, "chunk/TAL-1/agent-docs", "OPEN"),
      ],
    });

    const afterClose = scope.observe();

    assert.deepEqual([afterClose.open, afterClose.merged, afterClose.record.numbers], [[], 1, [5]]);
  });
});
