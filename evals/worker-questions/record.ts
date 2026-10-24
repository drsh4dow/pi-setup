// What run.ts keeps for each run in run.json, and grade.ts reads back.

import { Schema } from "effect";
import { ArmId, ScenarioId } from "./scenario.ts";

export const RoundRecord = Schema.Struct({
  index: Schema.Int,
  /** What started the round: the brief, an answered QUESTION: block, or a review directive. */
  trigger: Schema.Literals(["brief", "question", "directive"]),
  /** A fresh worker, or the previous round's session resumed. */
  launch: Schema.Literals(["fresh", "resume"]),
  startedAt: Schema.Finite,
  endedAt: Schema.Finite,
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  /** The session file Pi wrote, which a resumed round keeps appending to. */
  sessionPath: Schema.NullOr(Schema.String),
  /** The copy of that file as this round left it, relative to the run directory. */
  sessionCopy: Schema.NullOr(Schema.String),
  finalText: Schema.String,
});

export type RoundRecord = typeof RoundRecord.Type;

export const RunRecord = Schema.Struct({
  scenario: ScenarioId,
  arm: ArmId,
  model: Schema.String,
  thinking: Schema.String,
  trial: Schema.Int,
  harness: Schema.String,
  harnessHead: Schema.String,
  workdir: Schema.String,
  baseSha: Schema.String,
  latencySeconds: Schema.Finite,
  setupProblems: Schema.Array(Schema.String),
  startedAt: Schema.Finite,
  rounds: Schema.Array(RoundRecord),
  /** When the parent learned each mid-run fact, by its index in the scenario's knowledge. */
  learned: Schema.Array(Schema.Struct({ fact: Schema.Int, elapsedSeconds: Schema.Finite })),
  /** The parent's review of the last report before the follow-up, or none when no round ran. */
  review: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("accept") }),
      Schema.Struct({ kind: Schema.Literal("directive"), text: Schema.String }),
    ]),
  ),
});

export type RunRecord = typeof RunRecord.Type;

export const decodeRunRecord = Schema.decodeUnknownSync(Schema.fromJsonString(RunRecord));
