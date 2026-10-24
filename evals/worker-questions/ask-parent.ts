#!/usr/bin/env node
// `ask-parent "<question>"`: asks the parent one question and blocks until it answers, then
// prints the answer. Without an answer within $WQ_ASK_TIMEOUT_MS (default 10 minutes) it prints
// that none came and exits 3, so the worker decides on the evidence and reports the question.

import { randomUUID } from "node:crypto";
import { readAnswer, writeOutcome, writeQuestion, type ParentAnswer } from "./protocol.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

const POLL_MS = 500;

const askDir = process.env.WQ_ASK_DIR;

const question = process.argv.slice(2).join(" ").trim();

if (askDir === undefined) {
  process.stderr.write("ask-parent: no parent is listening (WQ_ASK_DIR is unset)\n");
  process.exit(2);
}

if (question === "") {
  process.stderr.write('usage: ask-parent "<one question, with the context the parent needs>"\n');
  process.exit(2);
}

const dir: string = askDir;

const timeoutMs = Number(process.env.WQ_ASK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;

const askedAt = Date.now();

writeQuestion(dir, { id, question, askedAt });

/** The parent's answer once it is written, or none once the timeout passes. Polls; one call waits at most once per poll. */
async function awaitAnswer(): Promise<ParentAnswer | undefined> {
  const answer = readAnswer(dir, id);

  if (answer !== undefined || Date.now() - askedAt >= timeoutMs) return answer;

  await new Promise((resolve) => setTimeout(resolve, POLL_MS));

  return awaitAnswer();
}

const answer = await awaitAnswer();

if (answer !== undefined) {
  writeOutcome(dir, id, { returnedAt: Date.now(), timedOut: false });
  process.stdout.write(`${answer.answer}\n`);
  process.exit(0);
}

writeOutcome(dir, id, { returnedAt: Date.now(), timedOut: true });

process.stdout.write(
  `No answer from the parent within ${Math.round(timeoutMs / 60_000)} minutes. Decide on the evidence, continue, and list the question in your report.\n`,
);

process.exit(3);
