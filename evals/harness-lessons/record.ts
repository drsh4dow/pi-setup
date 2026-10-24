import { Schema } from "effect";
import type { Session } from "../lib/session.ts";
import type { Judge } from "./judge.ts";
import type { Graded } from "./metrics.ts";
import { ScenarioId } from "./scenarios.ts";
import type { SetupSnapshot } from "./workdir.ts";

export const RunRecord = Schema.Struct({
  scenario: ScenarioId,
  arm: Schema.String,
  /** The harness checkout whose system prompt, skills, and prompts the run loaded. */
  armRoot: Schema.String,
  armHead: Schema.String,
  model: Schema.String,
  thinking: Schema.String,
  trial: Schema.Int,
  workdir: Schema.String,
  /** Setup checks that failed. The run was not launched when any did. */
  setupProblems: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  durationMs: Schema.Finite,
  session: Schema.NullOr(Schema.String),
});

export type RunRecord = typeof RunRecord.Type;

export const decodeRunRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord));

export interface GradeInput {
  readonly run: RunRecord;
  readonly setup: SetupSnapshot;
  readonly session: Session;
  /** The run's result directory, holding the records setup and the fake GitHub wrote. */
  readonly outputDir: string;
  readonly judge: Judge;
}

export type Grader = (input: GradeInput) => Promise<Graded>;
