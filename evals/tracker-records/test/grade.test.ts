import assert from "node:assert/strict";
import { test } from "node:test";
import { checkToSpec, checkToTickets, type Issue } from "../grade.ts";

function issue(id: number, fields: Partial<Issue> = {}): Issue {
  return {
    id,
    title: `checkout: ticket ${id}`,
    body: "",
    labels: [],
    parent: null,
    blockedBy: [],
    comments: [],
    closed: false,
    ...fields,
  };
}

const failed = (checks: readonly { name: string; pass: boolean }[]) =>
  checks.flatMap((check) => (check.pass ? [] : [check.name]));

const specBody = [
  "## Problem Statement",
  "Shoppers cannot pay with gift cards.",
  "## Solution",
  "Checkout accepts a gift card and shows the remaining balance.",
  "## User Stories",
  "1. As a shopper, I want to apply a gift card, so that I can spend it.",
  "## Implementation Decisions",
  "- Balances are held in cents.",
  "## Testing Decisions",
  "- Test redemption through the checkout module.",
  "## Out of Scope",
  "- Selling gift cards.",
].join("\n\n");

test("a spec passes with every template section, and names each one it misses", () => {
  assert.deepEqual(failed(checkToSpec([issue(1, { body: specBody })])), []);

  const thin = issue(1, { body: "## User Stories\n\n1. ...\n\n## Out of Scope\n\n- ..." });
  const checks = checkToSpec([thin]);

  assert.deepEqual(failed(checks), ["fills the spec template"]);
  assert.match(
    checks.find((check) => !check.pass)?.detail ?? "",
    /Problem Statement.*Testing Decisions/,
  );
});

test("a labelled spec fails", () => {
  assert.deepEqual(failed(checkToSpec([issue(1, { body: specBody, labels: ["ready"] })])), [
    "applies no label",
  ]);
});

const view = { command: "view", positionals: ["1"] };

const ticketBody = [
  "## Problem",
  "A shopper can apply a gift card at checkout and see the remaining balance.",
  "## Done when",
  "- [ ] `npm test -- giftcard` passes, covering a partial and a full redemption.",
].join("\n\n");

const ticket = (id: number, fields: Partial<Issue> = {}) =>
  issue(id, { parent: 1, body: ticketBody, ...fields });

const good = [issue(1), ticket(2), ticket(3, { blockedBy: [2] })];

test("nested, unlabelled, well-formed, ordered tickets that leave the parent alone pass", () => {
  assert.deepEqual(failed(checkToTickets(good, [view])), []);
});

test("each ticket protection fails on its own", () => {
  const cases: [string, Issue[], string][] = [
    ["unparented", [issue(1), ticket(2, { parent: null }), good[2]], "nests every ticket under #1"],
    ["wrong parent", [issue(1), ticket(2, { parent: 3 }), good[2]], "nests every ticket under #1"],
    ["labelled", [issue(1), ticket(2, { labels: ["ready"] }), good[2]], "applies no label"],
    [
      "blank body",
      [issue(1), ticket(2, { body: "" }), good[2]],
      "passes writing-good-tickets' body check",
    ],
    [
      "no done-when",
      [issue(1), ticket(2, { body: "## Problem\n\nGift cards." }), good[2]],
      "passes writing-good-tickets' body check",
    ],
  ];

  for (const [label, issues, check] of cases) {
    assert.deepEqual(failed(checkToTickets(issues, [view])), [check], label);
  }
});

test("a blocker published after what it blocks, and a closed parent, both fail", () => {
  const backwards = [issue(1), ticket(2, { blockedBy: [3] }), ticket(3)];

  assert.deepEqual(
    failed(checkToTickets(backwards, [view, { command: "close", positionals: ["1"] }])),
    ["publishes blockers before what they block", "leaves the parent issue alone"],
  );
});
