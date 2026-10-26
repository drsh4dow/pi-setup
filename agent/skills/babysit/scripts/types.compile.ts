import { parsePrNumber } from "./types.ts";
import type {
  CiClean,
  CiNoChecks,
  GitHubMergeAllowed,
  PrContext,
  ReadyPr,
  TerminalVerdict,
} from "./types.ts";

type ReadyVerdict = Extract<TerminalVerdict, { readonly kind: "READY" }>;

const context = {
  owner: "octocat",
  repo: "hello-world",
  number: parsePrNumber(123),
} satisfies PrContext;
const cleanCi = {
  kind: "ci-clean",
  source: "gh-pr-checks",
  all: [
    {
      kind: "passed",
      name: "ci",
      reportedState: "SUCCESS",
      description: "",
      link: "",
      workflow: "",
    },
  ],
  failed: [],
  pending: [],
  hadPreviousPassingCi: false,
  github: {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: "CLEAN",
    headRollupState: "SUCCESS",
  },
} satisfies CiClean;
const readyPr = {
  kind: "ready-pr",
  context,
  proof: {
    mergeability: "clear",
    threads: [],
    ci: cleanCi,
    gate: {
      state: "OPEN",
      reviewDecision: "APPROVED",
      draft: "not-draft",
    },
  },
} satisfies ReadyPr;
const ready = {
  schemaVersion: 1,
  sequence: 1,
  observedAt: "2026-07-26T00:00:00.000Z",
  mode: "single",
  kind: "READY",
  terminal: true,
  exitCode: 0,
  scope: { kind: "single", pr: readyPr },
} satisfies ReadyVerdict;

void ready;

// A commit with no checks is clear CI for merge-ready (no CI to wait for).
const noChecksCi = {
  kind: "ci-no-checks",
  failed: [],
  pending: [],
  hadPreviousPassingCi: false,
  github: cleanCi.github,
} satisfies CiNoChecks;
const noChecksReady = {
  ...readyPr,
  proof: { ...readyPr.proof, ci: noChecksCi },
} satisfies ReadyPr;

void noChecksReady;

// PR 179929's shape. Each assertion below stays a single short statement so a
// reformat cannot drift the directive away from the line that actually errors.
const refused = {
  kind: "allowed",
  basis: "rollup",
  mergeStateStatus: "BLOCKED",
  headRollupState: "FAILURE",
} as const;

// @ts-expect-error BLOCKED with a failing rollup is a refusal, not an allowance.
const refusalIsNotAllowed: GitHubMergeAllowed = refused;

// @ts-expect-error CI cannot be clean while GitHub refuses the merge.
const refusalIsNotClean: CiClean = { ...cleanCi, github: refused };

// @ts-expect-error A commit with no checks cannot be clear while GitHub refuses the merge.
const refusalIsNotNoChecks: CiNoChecks = { ...noChecksCi, github: refused };

// @ts-expect-error READY cannot carry the failing-checks exit code.
const readyWithBlockerExit: ReadyVerdict = { ...ready, exitCode: 4 };

const unprovenPr = { kind: "ready-pr", context } as const;

// @ts-expect-error An open READY row must carry positive readiness proof.
const readyWithoutProof: ReadyPr = unprovenPr;

void refusalIsNotAllowed;
void refusalIsNotClean;
void refusalIsNotNoChecks;
void readyWithBlockerExit;
void readyWithoutProof;
