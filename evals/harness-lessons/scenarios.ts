import { Schema } from "effect";
import { catchupChat } from "./catchup-chat.ts";
import { RECORDED_STATE, recordedChat } from "./recorded.ts";

export const ScenarioId = Schema.Literals([
  "live-reader-rebase",
  "live-run-verify",
  "concurrent-main",
  "vacuous-pass",
  "new-gate",
  "skill-tuning-method",
  "cross-project",
  "adapt-outside-skill",
  "bounded-recheck",
  "dependency-by-path",
  "cosmetic-wake",
  "restate-sharpened",
  "hand-edits-use-edit",
  "catchup",
  "catchup-video",
  "catchup-video-recorded",
]);

export type ScenarioId = typeof ScenarioId.Type;

/**
 * Where the working directory comes from: a fixture under fixtures/ committed into a fresh
 * repository, a clone of the arm's harness checkout at its committed HEAD, or the repository of a
 * recorded session at the commit it ended on (recorded.ts).
 */
export type Project =
  | { readonly kind: "fixture"; readonly fixture: string }
  | { readonly kind: "clone" }
  | { readonly kind: "recording" };

/**
 * The stand-in for GitHub on the run's PATH: the babysit fake serving PR #42 (fakegh.ts), the
 * catchup stubs serving PRs #51 to #53 with an `xdg-open` that opens nothing (catchup-stubs.ts),
 * or a recording's PR snapshot behind the same refusals and `xdg-open` (recorded-stubs.ts).
 */
export type FakeGitHub = "babysit-pr-42" | "catchup-prs" | "recorded-prs";

export interface Scenario {
  readonly id: ScenarioId;
  readonly project: Project;
  /** Script under setup/ run in the working directory after it is created, or none. */
  readonly setup: string | null;
  readonly prompt: string;
  readonly timeoutMinutes: number;
  readonly trials: number;
  /**
   * The state folder the runs write (state-folder.ts), named by the repository name of the
   * working directory's `origin`, or none. Runs naming the same folder never overlap, and the
   * runner moves the folder into each run's output directory once the run ends.
   */
  readonly stateFolder: string | null;
  readonly fakeGitHub: FakeGitHub | null;
  /**
   * The chat the run continues instead of starting fresh, as session JSONL for the working
   * directory's real path. The run's own turn starts at the prompt, its last user message.
   */
  readonly seededChat: ((cwd: string) => string) | null;
  /** Paths under the working directory whose modification times setup records. */
  readonly watchedPaths: readonly string[];
  /**
   * The run keeps a watcher armed, so Pi waits on it until the timeout. A timeout counts as the
   * run's end when the agent had finished its turn, waiting on the watcher.
   */
  readonly endsByTimeout: boolean;
  /**
   * Runs without --only. A scenario whose behavior a print-mode run cannot show stays out of the
   * default set and runs only when named.
   */
  readonly byDefault: boolean;
}

const fixture = (name: string): Project => ({ kind: "fixture", fixture: name });

const clone: Project = { kind: "clone" };

/**
 * The state folder of the gift-registry scenarios: their `origin` names the repository
 * gift-registry, as the story's `acme/gift-registry` does.
 */
export const GIFT_REGISTRY_STATE = "gift-registry";

const DEFAULTS = {
  setup: null,
  timeoutMinutes: 20,
  trials: 3,
  stateFolder: null,
  fakeGitHub: null,
  seededChat: null,
  watchedPaths: [],
  endsByTimeout: false,
  byDefault: true,
} as const;

// Prompts read like a user's request: they name no measurement and not the expected behavior.
const table: Record<ScenarioId, Omit<Scenario, "id">> = {
  "live-reader-rebase": {
    ...DEFAULTS,
    project: fixture("report-service"),
    setup: "live-reader-rebase.sh",
    prompt:
      "Rebase feature onto main and tighten the wording in templates/summary.md. My eval batch from this morning is still going in the background (batch.log).",
  },
  "live-run-verify": {
    ...DEFAULTS,
    project: clone,
    setup: "live-run-verify.sh",
    timeoutMinutes: 30,
    watchedPaths: [".build/bin"],
    prompt:
      "Before I open the PR, check that each commit on docs-tweak passes vp run verify. My eval batch is still going in the background (evals.log).",
  },
  "concurrent-main": {
    ...DEFAULTS,
    project: clone,
    setup: "concurrent-main.sh",
    prompt:
      "Add a sentence to docs/development.md saying that eval results under evals/*/results/ are gitignored and safe to delete, then merge it to main.",
  },
  "vacuous-pass": {
    ...DEFAULTS,
    project: fixture("docs-site"),
    prompt:
      "Add a short Troubleshooting section to docs/setup.md that links to the FAQ, and make sure scripts/check-links.sh passes.",
  },
  "new-gate": {
    ...DEFAULTS,
    project: fixture("web-app"),
    setup: "new-gate.sh",
    prompt:
      "Reviews keep catching console.log left in src. Add a check for that to scripts/verify.sh.",
  },
  "skill-tuning-method": {
    ...DEFAULTS,
    project: clone,
    trials: 2,
    timeoutMinutes: 45,
    prompt:
      "When people say 'keep an eye on my PR', the babysit skill doesn't get picked up. Improve its description, and show me evidence that the new one triggers better without firing on unrelated requests.",
  },
  "cross-project": {
    ...DEFAULTS,
    project: clone,
    prompt:
      "Write a skill at agent/skills/pre-commit-checks that makes agents run the project's checks before they commit. I've already weighed hooks and extensions; I want the skill.",
  },
  "adapt-outside-skill": {
    ...DEFAULTS,
    project: clone,
    setup: "adapt-outside-skill.sh",
    prompt:
      "Adapt incoming/changelog-skill into our harness as agent/skills/writing-changelogs. Its guidance is good, keep it.",
  },
  "bounded-recheck": {
    ...DEFAULTS,
    project: clone,
    prompt:
      "Write a prompt template at agent/prompts/release-notes.md that has the agent draft release notes from the git log since the last tag, review its draft for gaps, and fix them.",
  },
  "dependency-by-path": {
    ...DEFAULTS,
    project: clone,
    prompt:
      "Write a skill at agent/skills/writing-release-notes for drafting release notes. Its last step should run our unslop skill over the prose.",
  },
  "cosmetic-wake": {
    ...DEFAULTS,
    project: fixture("gift-registry"),
    setup: "cosmetic-wake.sh",
    timeoutMinutes: 15,
    stateFolder: GIFT_REGISTRY_STATE,
    fakeGitHub: "babysit-pr-42",
    endsByTimeout: true,
    // Every print-mode run ends on a final message, so "no message for a cosmetic item" never shows.
    byDefault: false,
    prompt:
      "Babysit PR #42 until it's merge-ready. It was merge-ready at your last report; the watcher just woke you again.",
  },
  "restate-sharpened": {
    ...DEFAULTS,
    project: fixture("http-client"),
    setup: "restate-sharpened.sh",
    prompt:
      "/restate-sharpened I want our release notes to also get posted to the team chat when we tag a release.",
  },
  "hand-edits-use-edit": {
    ...DEFAULTS,
    project: fixture("http-client"),
    prompt:
      "Three changes to the retry option: in src/config.ts change the default retryCount from 3 to 5; in src/client.ts make a negative retryCount throw a RangeError with the message 'retryCount must be >= 0'; in README.md update the options table so retryCount's default is 5 and its description says negative values throw.",
  },
  catchup: {
    ...DEFAULTS,
    project: fixture("gift-registry"),
    setup: "catchup.sh",
    stateFolder: GIFT_REGISTRY_STATE,
    fakeGitHub: "catchup-prs",
    seededChat: catchupChat,
    prompt: "/skill:catchup",
  },
  "catchup-video": {
    ...DEFAULTS,
    project: fixture("gift-registry"),
    setup: "catchup.sh",
    timeoutMinutes: 30,
    stateFolder: GIFT_REGISTRY_STATE,
    fakeGitHub: "catchup-prs",
    seededChat: catchupChat,
    prompt: "/skill:catchup-video",
  },
  // Company data stays out of the repository: the session it continues is a recording in the
  // state folder, so the scenario runs only where one exists and only when named.
  "catchup-video-recorded": {
    ...DEFAULTS,
    project: { kind: "recording" },
    timeoutMinutes: 30,
    stateFolder: RECORDED_STATE,
    fakeGitHub: "recorded-prs",
    seededChat: recordedChat,
    byDefault: false,
    prompt: "/skill:catchup-video",
  },
};

export function scenarioById(id: ScenarioId): Scenario {
  return Object.assign({ id }, table[id]);
}

export const scenarios: readonly Scenario[] = ScenarioId.literals.map(scenarioById);
