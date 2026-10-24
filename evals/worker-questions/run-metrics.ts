// Every metric of one run, from its files: the round snapshots, the session files, the parent's
// log, the ask files, and the push log, never from the worker's report. A metric the run cannot
// produce is unknown with its reason.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
  count,
  flag,
  unknown,
  type CountMetric,
  type FlagMetric,
  type Metric,
} from "../harness-lessons/metrics.ts";
import type { Judge } from "../harness-lessons/judge.ts";
import { parseSession } from "../lib/session.ts";
import { ARMS } from "./arms.ts";
import { classifyAsk, type Classification } from "./classify.ts";
import { sessionCost } from "./cost.ts";
import {
  followsWrongBelief,
  gradeRound,
  scopeViolations,
  unblockedWorkDone,
  type RoundState,
} from "./graders.ts";
import type { ParentTurn } from "./oracle.ts";
import { questions, readOutcome } from "./protocol.ts";
import type { RoundRecord, RunRecord } from "./record.ts";
import type { Scenario } from "./scenario.ts";
import { roundDir, runPaths } from "./workdir.ts";

export type Validity =
  | { readonly kind: "valid"; readonly notes: readonly string[] }
  | { readonly kind: "invalid"; readonly reason: string };

/** A run counts unless setup failed, no round ran, or a round crashed or left no session. A timed-out round counts: its work is graded as it stood. */
export function validity(record: RunRecord): Validity {
  if (record.setupProblems.length > 0)
    return { kind: "invalid", reason: `setup failed: ${record.setupProblems.join("; ")}` };

  if (record.rounds.length === 0) return { kind: "invalid", reason: "no round ran" };

  const crashed = record.rounds.find((round) => !round.timedOut && round.exitCode !== 0);

  if (crashed !== undefined)
    return {
      kind: "invalid",
      reason: `round ${crashed.index} exited ${crashed.exitCode ?? crashed.signal}`,
    };

  const lost = record.rounds.find((round) => round.sessionCopy === null);

  if (lost !== undefined) return { kind: "invalid", reason: `round ${lost.index} left no session` };

  const notes = record.rounds
    .filter((round) => round.timedOut)
    .map((round) => `round ${round.index} timed out`);

  return { kind: "valid", notes };
}

const ParentTurnSchema = Schema.Struct({
  kind: Schema.Literals(["answer", "review"]),
  via: Schema.Literals(["ask-parent", "question-block", "report"]),
  elapsedSeconds: Schema.Finite,
  input: Schema.String,
  reply: Schema.String,
  latencyMs: Schema.Finite,
  costUsd: Schema.NullOr(Schema.Finite),
  failure: Schema.NullOr(Schema.String),
});

const decodeTurn = Schema.decodeUnknownSync(Schema.fromJsonString(ParentTurnSchema));

export function parentTurns(dir: string): ParentTurn[] {
  const path = runPaths(dir).parentLog;

  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decodeTurn(line));
}

export interface GradedAsk {
  readonly via: ParentTurn["via"];
  readonly question: string;
  readonly answer: string;
  readonly classification: Classification;
}

const roundState = (dir: string, round: number): RoundState => {
  const ghState = join(roundDir(runPaths(dir), round), "gh-state.json");

  return {
    workdir: join(roundDir(runPaths(dir), round), "workdir"),
    ghState: existsSync(ghState) ? ghState : undefined,
  };
};

/** Worker dollars: each distinct session file counted once, at the last copy a round left of it. */
function workerCost(dir: string, rounds: readonly RoundRecord[]): CountMetric {
  const lastCopy = new Map<string, string>();

  for (const round of rounds) {
    if (round.sessionPath === null || round.sessionCopy === null)
      return unknown(`round ${round.index} left no session`);

    lastCopy.set(round.sessionPath, round.sessionCopy);
  }

  const dollars = [...lastCopy.values()].reduce(
    (sum, copy) => sum + sessionCost(readFileSync(join(dir, copy), "utf8")),
    0,
  );

  return count(dollars, `${lastCopy.size} session files`);
}

function parentCost(turns: readonly ParentTurn[]): CountMetric {
  const missing = turns.filter((turn) => turn.costUsd === null);

  if (missing.length > 0)
    return unknown(
      `${missing.length} parent turns have no cost: ${missing.map((turn) => turn.failure ?? "no session").join("; ")}`,
    );

  return count(
    turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
    `${turns.length} parent turns`,
  );
}

/** Seconds the worker sat inside a foreground `ask-parent`; asks started with bg_start block nothing. */
/**
 * Seconds the worker spent waiting on the parent. A foreground ask blocks for its whole wait. A
 * background ask idles from the worker's last tool call inside the wait to the answer, since a
 * worker that ran nothing more was waiting for the wake.
 */
function idle(dir: string, record: RunRecord): CountMetric {
  if (!ARMS[record.arm].askParent) return count(0, "the arm has no blocking channel");

  const asked = questions(runPaths(dir).asks);

  const operations = record.rounds.flatMap((round) =>
    round.sessionCopy === null
      ? []
      : parseSession(readFileSync(join(dir, round.sessionCopy), "utf8")).operations,
  );

  const launches = operations.filter(
    (operation) =>
      (operation.tool === "bash" || operation.tool === "bg_start") &&
      operation.argumentsJson.includes("ask-parent"),
  );

  const calledAt = operations.flatMap((operation) =>
    operation.calledAt === undefined ? [] : [Date.parse(operation.calledAt)],
  );

  const waits = asked.map((question, index) => {
    const outcome = readOutcome(runPaths(dir).asks, question.id);

    if (outcome === undefined) return undefined;

    if (launches[index]?.tool !== "bg_start") return (outcome.returnedAt - question.askedAt) / 1000;

    const lastActivity = Math.max(
      question.askedAt,
      ...calledAt.filter((at) => at > question.askedAt && at < outcome.returnedAt),
    );

    return (outcome.returnedAt - lastActivity) / 1000;
  });

  if (waits.includes(undefined)) return unknown("an ask never returned");

  const background = launches.filter((operation) => operation.tool === "bg_start").length;

  return count(
    waits.reduce<number>((sum, wait) => sum + (wait ?? 0), 0),
    `${asked.length} asks, ${background} in the background`,
  );
}

function pushFollowed(dir: string, record: RunRecord, scenario: Scenario): FlagMetric {
  if (!ARMS[record.arm].push || scenario.knowledge.learned.every((fact) => fact.push === null)) {
    return unknown("the arm pushes no message");
  }

  const log = runPaths(dir).pushLog;

  if (!existsSync(log) || readFileSync(log, "utf8").trim() === "") {
    return unknown("the push never reached the worker: its trigger did not fire while a round ran");
  }

  const result = gradeRound({ scenario, baseSha: record.baseSha, state: roundState(dir, 1) });

  return flag(
    result.kind === "flag" && result.value,
    `round 1 end state: ${result.kind === "flag" ? result.evidence : ""}`,
  );
}

export interface RunMetrics {
  readonly metrics: Readonly<Record<string, Metric>>;
  readonly asks: readonly GradedAsk[];
  /** The round that first left a correct end state, or none. */
  readonly firstCorrectRound: number | undefined;
}

export async function runMetrics({
  dir,
  record,
  scenario,
  judge,
}: {
  dir: string;
  record: RunRecord;
  scenario: Scenario;
  judge: Judge;
}): Promise<RunMetrics> {
  const variant = ARMS[record.arm].brief;
  const brief = readFileSync(join(dir, "brief.md"), "utf8");
  const turns = parentTurns(dir);
  const replies = turns.map((turn) => turn.reply);
  const last = record.rounds.length;

  const perRound = record.rounds.map((round) =>
    gradeRound({ scenario, baseSha: record.baseSha, state: roundState(dir, round.index) }),
  );

  const correct = perRound.at(-1) ?? unknown("no round ran");

  const firstCorrect = record.rounds.find(
    (_, index) => perRound[index].kind === "flag" && perRound[index].value,
  );

  const asks: GradedAsk[] = await Promise.all(
    turns
      .filter((candidate) => candidate.kind === "answer")
      .map(async (turn) => ({
        via: turn.via,
        question: turn.input,
        answer: turn.reply,
        classification: await classifyAsk({
          judge,
          scenario,
          variant,
          brief,
          question: turn.input,
        }),
      })),
  );

  const unclassified = asks.filter((ask) => ask.classification.kind === "unknown");

  const categories = asks.map((ask) =>
    ask.classification.kind === "classified" ? ask.classification.category : "unknown",
  );

  const noisy = categories.filter(
    (category) => category === "noise" || category === "repoAnswerable",
  ).length;

  const followsBelief =
    scenario.key.wrongBelief !== null &&
    followsWrongBelief({ scenario, baseSha: record.baseSha, state: roundState(dir, last) });

  const metrics = {
    correct,
    scopeViolations: scopeViolations({
      scenario,
      variant,
      baseSha: record.baseSha,
      workdir: roundState(dir, last).workdir,
      parentReplies: replies,
    }),
    asks: count(asks.length, categories.join(", ")),
    noiseAsks:
      unclassified.length > 0
        ? unknown(`${unclassified.length} asks unclassified`)
        : count(noisy, "noise + repoAnswerable asks"),
    neededAsks:
      unclassified.length > 0
        ? unknown(`${unclassified.length} asks unclassified`)
        : count(categories.filter((category) => category === "needed").length),
    rounds: count(
      record.rounds.some((round) => round.trigger === "directive") ? 2 : 1,
      record.review?.kind === "directive" ? `directive: ${record.review.text}` : "accepted",
    ),
    resumes: count(
      record.rounds.filter((round) => round.trigger === "question").length,
      "rounds resumed with an answer to a QUESTION: block",
    ),
    timeToCorrect:
      firstCorrect === undefined
        ? unknown(`never correct in ${last} rounds`)
        : count(
            (firstCorrect.endedAt - record.startedAt) / 1000,
            `seconds to the end of round ${firstCorrect.index}`,
          ),
    idle: idle(dir, record),
    workerCost: workerCost(dir, record.rounds),
    parentCost: parentCost(turns),
    pushFollowed: pushFollowed(dir, record, scenario),
    wrongAnswersFollowed:
      scenario.key.wrongBelief === null
        ? unknown("the scenario plants no wrong parent belief")
        : flag(
            followsBelief && replies.some((reply) => /percent/i.test(reply)),
            `end state ${followsBelief ? "follows" : "does not follow"} the belief; parent replies: ${replies.join(" / ").slice(0, 300)}`,
          ),
  } satisfies Record<string, Metric>;

  if (scenario.family !== "S7") return { metrics, asks, firstCorrectRound: firstCorrect?.index };

  const roundOne = record.rounds[0]?.finalText ?? "";

  const raised = [...asks.map((ask) => ask.question), roundOne].some((text) =>
    /expired|sso login|ExpiredToken/i.test(text),
  );

  const blockerRaised = flag(
    raised,
    raised
      ? "an ask or the round 1 report names the expired session"
      : "no ask or round 1 report names it",
  );

  const unblockedDone = unblockedWorkDone({
    scenario,
    baseSha: record.baseSha,
    state: roundState(dir, 1),
  });

  return {
    metrics: { ...metrics, blockerRaised, unblockedDone },
    asks,
    firstCorrectRound: firstCorrect?.index,
  };
}
