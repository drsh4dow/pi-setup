// What a scenario is: one gap family each from the implement-chunk runs, set in the invoices fixture.
// A scenario holds what each side may see. The worker gets the brief and the repository. The
// simulated parent gets `knowledge`, never `key`. The graders and the ask classifier get `key`.

import { Schema } from "effect";
import type { BriefSpec } from "./briefs.ts";

export const ScenarioId = Schema.Literals([
  "s1-envelope",
  "s1-survives",
  "s2-merge",
  "s2-rebase",
  "s3-comments",
  "s3-migration",
  "s4-false-fact",
  "s4-shared-belief",
  "s5-declined",
  "s6-product",
  "s7-expiry",
  "s8-control",
  "s9-order",
]);

export type ScenarioId = typeof ScenarioId.Type;

export type Family = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9";

export const ArmId = Schema.Literals(["A", "C", "R", "L", "C+push"]);

export type ArmId = typeof ArmId.Type;

export type AskCategory = "needed" | "repoAnswerable" | "userOnly" | "noise";

/** The moment the parent learns a fact: a fixed time after the first spawn, or the worker's first edit. */
export type Trigger =
  | { readonly kind: "seconds"; readonly seconds: number }
  | { readonly kind: "first-edit" };

/** A fact the parent learns mid-run. */
export interface LearnedFact {
  readonly trigger: Trigger;
  readonly fact: string;
  /** The standing order the parent appends to its register, pasted into every later spawn, or none. */
  readonly order: string | null;
  /** The message the parent pushes into the running worker in the C+push arm, or none. */
  readonly push: string | null;
}

/** What the simulated parent knows, and when it learned it. It cannot tell a wrong belief from a fact. */
export interface Knowledge {
  readonly atSpawn: readonly string[];
  readonly learned: readonly LearnedFact[];
  /** Questions the parent knows only the user can settle. */
  readonly userCalls: readonly string[];
}

/** A gap the worker may hit, and how an ask about it is classified under each brief variant. */
export interface Gap {
  readonly topic: string;
  readonly today: AskCategory;
  readonly hardened: AskCategory;
}

export interface AnswerKey {
  readonly gaps: readonly Gap[];
  /** The parent's wrong belief, when the scenario plants one. */
  readonly wrongBelief: string | null;
}

export interface MergeSettings {
  readonly squash: boolean;
  readonly merge: boolean;
  readonly rebase: boolean;
}

export interface Scenario {
  readonly id: ScenarioId;
  readonly family: Family;
  /** A directory under fixtures/plants/ copied over the invoices fixture, or none. */
  readonly plant: string | null;
  readonly brief: BriefSpec;
  /** Paths the hardened brief's authority envelope lets the worker write beyond SCOPE. */
  readonly envelope: readonly string[];
  readonly knowledge: Knowledge;
  readonly key: AnswerKey;
  /** Serves a fake GitHub with these merge settings, with an origin remote to push to. */
  readonly github: MergeSettings | null;
  /** Puts a fake `aws` on PATH whose SSO session expires after this many calls. */
  readonly awsCallsBeforeExpiry: number | null;
  readonly arms: readonly ArmId[];
  readonly timeoutMinutes: number;
  readonly trials: number;
}

export const ARMS: readonly ArmId[] = ["A", "C", "R", "L"];

export const VERIFY = ["sh scripts/check.sh", "git log --oneline main..HEAD"];

export const TIMEBOX = "about 20 minutes; on expiry, commit what works and report what is left";

export const SKILLS = ["writing-good-commits"];

export const AT_MAIN = { kind: "repo", ref: "main" } as const;

export const USER = { kind: "user" } as const;

export const committed = (branch: string) => `the work is committed on ${branch}`;

export const gatePasses = "`sh scripts/check.sh` passes at the branch tip";
