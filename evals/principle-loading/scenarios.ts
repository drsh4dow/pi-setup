import type { PrincipleName } from "./grade.ts";

export interface Scenario {
  /** The principle whose trigger this scenario sets up. Also the scenario's id. */
  readonly target: PrincipleName;
  /** Directory under fixtures/ copied into the candidate's working directory. */
  readonly fixture: string;
  /** Script under setup/ run in the working directory after the initial commit. */
  readonly setup?: string;
  readonly prompt: string;
}

/**
 * Fixtures whose servers listen on a fixed port. Candidates start them to try their change, so
 * runs of fixtures sharing a port must not overlap, or one run's requests reach another's server.
 */
export const fixturePorts: ReadonlyMap<string, number> = new Map([
  ["storefront", 3000],
  ["inventory-api", 3000],
  ["request-pipeline", 3000],
]);

// Prompts read like a user's request: no meta words, and no mention of skills or principles.
export const scenarios: readonly Scenario[] = [
  {
    target: "principle-laziness-protocol",
    fixture: "config-loader",
    prompt:
      "We need to support TOML config files too. Make the loader extensible so we can plug in YAML and other formats later.",
  },
  {
    target: "principle-redesign-from-first-principles",
    fixture: "billing",
    prompt:
      "We're launching team plans: an invoice will belong to an organization (several members, one billing contact who gets the emails and whose card is charged) instead of a single user. Update the billing code for that.",
  },
  {
    target: "principle-attack-the-premise",
    fixture: "sync-service",
    setup: "sync-service.sh",
    prompt:
      "test/sync.test.js still fails in CI every few runs, even after my last two fixes (see the last two commits). The CI output is in ci-failures.txt. Can you try another fix?",
  },
  {
    target: "principle-subtract-before-you-add",
    fixture: "inventory-api",
    prompt: "Add pagination (limit and offset query params) to GET /items.",
  },
  {
    target: "principle-minimize-reader-load",
    fixture: "request-pipeline",
    prompt:
      "I can't follow how a request gets from server.js to the users handler anymore, and every change here takes forever. Can you clean this up?",
  },
  {
    target: "principle-experience-first",
    fixture: "csv-cli",
    prompt:
      "People keep opening issues (ISSUES.md) because csvstat dumps stack traces at them. The quick option is a note in the README, but do whatever you think is actually right for the people using it.",
  },
  {
    target: "principle-exhaust-the-design-space",
    fixture: "whiteboard",
    prompt:
      "Add undo/redo to the whiteboard. It has to behave sensibly when several people are editing the same board at once. Nothing in the codebase does anything like this yet, so figure out how it should work and build it.",
  },
  {
    target: "principle-build-the-lever",
    fixture: "user-service",
    setup: "user-service.sh",
    prompt:
      "Rename userId to accountId across this service: code, tests, docs, and the schema. Priya will review the change, and next week we need to make exactly the same rename in the payments, notifications, and search services.",
  },
  {
    target: "principle-model-the-domain",
    fixture: "storefront",
    prompt:
      "Orders need a real lifecycle: pending, paid, shipped, delivered. An order can be cancelled until it ships, and refunded (fully or partially) once it's paid. Implement this in src/orders.",
  },
  {
    target: "principle-boundary-discipline",
    fixture: "storefront",
    prompt:
      "Add a POST /webhooks/paylane endpoint. When Paylane sends charge.succeeded, mark the matching order as paid. Their webhook format is in docs/psp-api.md.",
  },
  {
    target: "principle-type-system-discipline",
    fixture: "storefront",
    prompt:
      "We're integrating Paylane for payments (API notes in docs/psp-api.md). Before any implementation, write src/payments/types.ts with the types and function signatures for our client: customers, payment methods, charges, and refunds.",
  },
  {
    target: "principle-make-operations-idempotent",
    fixture: "release-tools",
    prompt:
      "Write scripts/deploy.sh for the CI deploy job described in the README: apply the pending migrations to the database, install build/ as a new release, and switch current over to it.",
  },
  {
    target: "principle-separate-before-serializing-shared-state",
    fixture: "crawler",
    prompt:
      "Every few days results.json ends up corrupted or missing entries after a crawl. Can you fix it?",
  },
  {
    target: "principle-prove-it-works",
    fixture: "storefront",
    prompt:
      "Add a GET /orders/:id endpoint that returns the order as JSON, or a 404 if there's no such order.",
  },
  {
    target: "principle-fix-root-causes",
    fixture: "storefront",
    prompt:
      "The daily report job crashes with `TypeError: Cannot read properties of undefined (reading 'email')` in generateDailyReport when I run it for 2026-10-21. Can you fix it?",
  },
  {
    target: "principle-sequence-verifiable-units",
    fixture: "handlers",
    setup: "handlers.sh",
    prompt:
      "Migrate the db module and every handler in src/handlers from callbacks to async/await. I'll open a PR from this branch, so commit it in a way that's easy to review.",
  },
  {
    target: "principle-test-behavior-not-implementation",
    fixture: "storefront",
    prompt: "src/cart/pricing.ts has no tests. Add a good test suite for it.",
  },
  {
    target: "principle-explain-the-number",
    fixture: "parser",
    prompt:
      "I rewrote the tokenizer and it's 3.2x faster, numbers are in bench.txt. Write the PR description for this change.",
  },
  {
    target: "principle-guard-the-context-window",
    fixture: "log-triage",
    setup: "log-triage.sh",
    prompt:
      "Last night's batch run wrote everything to logs/. Go through it and tell me which jobs failed and why.",
  },
  {
    target: "principle-ask-or-proceed",
    fixture: "rate-limiter",
    prompt: "Implement the rate limiting changes described in SPEC.md.",
  },
  {
    target: "principle-push-back",
    fixture: "api-client",
    prompt:
      "The client fails against staging with `unable to verify the first certificate` (staging-error.txt). Just set rejectUnauthorized: false in the client so it works everywhere, prod included. I don't want to deal with certs.",
  },
  {
    target: "principle-encode-lessons-in-structure",
    fixture: "storefront",
    setup: "storefront-any.sh",
    prompt:
      "Review flagged `any` again, this time in src/orders/totals.ts. That's the second time I've had to point this out, and AGENTS.md already says not to use it. Please fix it.",
  },
  {
    target: "principle-engineering-standards",
    fixture: "storefront",
    setup: "storefront-review.sh",
    prompt:
      "I've finished the orders CSV export on this branch. Can you review my changes against main before I open the PR?",
  },
];
