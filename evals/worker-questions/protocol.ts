// The two ways a worker asks its parent in this eval. Arm R ends its turn on a `QUESTION:`
// block and is resumed with the answer. Arm L runs `ask-parent "<question>"`, which leaves a
// question file in the run's ask directory and blocks until the parent's answer file appears.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Option, Schema } from "effect";
import { writeAtomically } from "../lib/pi-run.ts";

/**
 * The question a final message ends on: the text after its last line that starts with
 * `QUESTION:`, or none. Only the last block counts, so a report that quotes an earlier question
 * and then reports normally asks nothing.
 */
export function questionBlock(finalText: string): string | undefined {
  const lines = finalText.trimEnd().split("\n");
  const start = lines.findLastIndex((line) => /^\s*(?:\*\*)?QUESTION:(?:\*\*)?/.test(line));

  if (start === -1) return undefined;

  const first = lines[start].replace(/^\s*(?:\*\*)?QUESTION:(?:\*\*)?\s*/, "");
  const question = [first, ...lines.slice(start + 1)].join("\n").trim();

  return question === "" ? undefined : question;
}

export const AskedQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  askedAt: Schema.Finite,
});

export type AskedQuestion = typeof AskedQuestion.Type;

export const ParentAnswer = Schema.Struct({ answer: Schema.String, answeredAt: Schema.Finite });

export type ParentAnswer = typeof ParentAnswer.Type;

/** What `ask-parent` writes when it returns: the answer it printed, or its timeout. */
export const AskOutcome = Schema.Struct({
  returnedAt: Schema.Finite,
  timedOut: Schema.Boolean,
});

export type AskOutcome = typeof AskOutcome.Type;

const decodeQuestion = Schema.decodeUnknownSync(Schema.fromJsonString(AskedQuestion));

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(ParentAnswer));

const decodeOutcome = Schema.decodeUnknownSync(Schema.fromJsonString(AskOutcome));

export const askFiles = (dir: string, id: string) => ({
  question: join(dir, `${id}.question.json`),
  answer: join(dir, `${id}.answer.json`),
  outcome: join(dir, `${id}.outcome.json`),
});

export function writeQuestion(dir: string, question: AskedQuestion) {
  writeAtomically(askFiles(dir, question.id).question, `${JSON.stringify(question)}\n`);
}

export function writeAnswer(dir: string, id: string, answer: ParentAnswer) {
  writeAtomically(askFiles(dir, id).answer, `${JSON.stringify(answer)}\n`);
}

export function writeOutcome(dir: string, id: string, outcome: AskOutcome) {
  writeAtomically(askFiles(dir, id).outcome, `${JSON.stringify(outcome)}\n`);
}

/** The parent's answer to question `id`, once it has been written. */
export function readAnswer(dir: string, id: string): ParentAnswer | undefined {
  const path = askFiles(dir, id).answer;

  if (!existsSync(path)) return undefined;

  return Option.getOrUndefined(decodeAnswer(readFileSync(path, "utf8")));
}

/** Every question in the directory, oldest first. */
export function questions(dir: string): AskedQuestion[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith(".question.json"))
    .map((name) => decodeQuestion(readFileSync(join(dir, name), "utf8")))
    .toSorted((a, b) => a.askedAt - b.askedAt);
}

export function readOutcome(dir: string, id: string): AskOutcome | undefined {
  const path = askFiles(dir, id).outcome;

  return existsSync(path) ? decodeOutcome(readFileSync(path, "utf8")) : undefined;
}

const POLL_MS = 500;

/**
 * Answers each question in `dir` that has no answer yet, one at a time and in order, until
 * `until` settles. Resolves once the last answer started has been written.
 */
export async function serveQuestions({
  dir,
  answer,
  until,
}: {
  dir: string;
  answer: (question: AskedQuestion) => Promise<string>;
  until: Promise<unknown>;
}): Promise<void> {
  const state = { done: false };

  void until.finally(() => {
    state.done = true;
  });

  const handled = new Set<string>();

  const serveNext = async (): Promise<void> => {
    if (state.done) return;

    const next = questions(dir).find((question) => !handled.has(question.id));

    if (next === undefined) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    } else {
      handled.add(next.id);
      writeAnswer(dir, next.id, { answer: await answer(next), answeredAt: Date.now() });
    }

    return serveNext();
  };

  await serveNext();
}
