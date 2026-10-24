// The scripted user: what it replies to each kind of stop, and which PRs it takes as merge-ready.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answerSheet, asksQuestion, decide, mergeReadyClaims, type TurnEnd } from "../user.ts";

const sheet = { owner: "acme", repo: "tally-x", port: 4321 };

function turn(overrides: Partial<TurnEnd>): TurnEnd {
  return {
    text: "",
    intakeAnswered: true,
    mergedNow: [],
    openFinalPrs: 1,
    mergedFinalPrs: 0,
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

  test("takes as merge-ready only the PRs named in a paragraph that says so", () => {
    const text =
      "Opened #3 into the integration branch.\n\nThe final PR #9 is merge-ready: CI green, review threads resolved.\n\n- #4 still has a failing check.";

    assert.deepEqual(mergeReadyClaims(text), [9]);
  });
});
