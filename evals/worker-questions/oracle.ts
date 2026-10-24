// The simulated parent. It answers the worker's questions and reviews its final report from the
// scenario's `knowledge` as it stood at that moment, never from the graders' answer key, through
// one cheap `pi -p` call per turn. Every turn is logged with its latency and cost.

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { candidateEnv } from "../lib/pi-run.ts";
import { sessionCost } from "./cost.ts";
import type { Knowledge } from "./scenario.ts";

export const DONT_KNOW = "I don't know; decide and report.";

export const USERS_CALL = "That's the user's call; pick the reversible default and report it.";

export type Completion =
  | { readonly kind: "answered"; readonly text: string; readonly costUsd: number | undefined }
  | { readonly kind: "failed"; readonly reason: string };

/** One model turn of the parent: a prompt in, a reply and its cost out. */
export type ParentModel = (prompt: string) => Promise<Completion>;

const PARENT_TIMEOUT_MS = 5 * 60_000;

function newestSession(dir: string): string | undefined {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .at(-1);
}

/**
 * The parent as one `pi -p` call per turn, without tools, skills, or project context. Each turn
 * gets its own session directory under `sessionRoot`, so its cost reads from its session file.
 */
export function piParent({
  model,
  thinking,
  sessionRoot,
  piCommand = "pi",
}: {
  model: string;
  thinking: string;
  sessionRoot: string;
  piCommand?: string;
}): ParentModel {
  let turn = 0;

  return (prompt) => {
    turn += 1;

    const sessionDir = join(sessionRoot, `turn-${turn}`);

    mkdirSync(sessionDir, { recursive: true });

    return new Promise((resolve) => {
      const child = execFile(
        piCommand,
        [
          "-p",
          "--no-tools",
          "--no-skills",
          "--no-extensions",
          "--no-mcp",
          "--no-context-files",
          "--no-prompt-templates",
          "--session-dir",
          sessionDir,
          "--model",
          model,
          "--thinking",
          thinking,
          prompt,
        ],
        {
          cwd: sessionDir,
          env: candidateEnv(),
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: PARENT_TIMEOUT_MS,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              kind: "failed",
              reason: `pi failed: ${(stderr || error.message).slice(0, 300)}`,
            });

            return;
          }

          const session = newestSession(sessionDir);

          const costUsd =
            session === undefined ? undefined : sessionCost(readFileSync(session, "utf8"));

          resolve({ kind: "answered", text: stdout.trim(), costUsd });
        },
      );

      // `pi -p` waits for piped stdin to end before it runs.
      child.stdin?.end();
    });
  };
}

/** The facts the parent holds once it has learned the mid-run facts at the indexes in `learned`. */
export function knownFacts(knowledge: Knowledge, learned: ReadonlySet<number>): string[] {
  return [
    ...knowledge.atSpawn,
    ...knowledge.learned.filter((_, index) => learned.has(index)).map((item) => item.fact),
  ];
}

function knowledgeBlock(knowledge: Knowledge, learned: ReadonlySet<number>): string {
  const facts = knownFacts(knowledge, learned).map((fact) => `- ${fact}`);
  const userCalls = knowledge.userCalls.map((call) => `- ${call}`);

  return [
    "<<<WHAT_YOU_KNOW",
    ...(facts.length === 0 ? ["- nothing beyond the brief"] : facts),
    "WHAT_YOU_KNOW>>>",
    "<<<USER_CALLS (only the user can settle these)",
    ...(userCalls.length === 0
      ? ["- none listed; any product decision about what customers see or pay is the user's"]
      : userCalls),
    "USER_CALLS>>>",
  ].join("\n");
}

const ROLE =
  "You are the parent agent of a coding worker. You spawned it with the brief below and you are busy with other units. You know only what the brief says and what is listed under WHAT_YOU_KNOW. You have not read the repository, and you cannot run anything.";

export function answerPrompt({
  brief,
  knowledge,
  learned,
  question,
}: {
  brief: string;
  knowledge: Knowledge;
  learned: ReadonlySet<number>;
  question: string;
}): string {
  return [
    ROLE,
    "",
    "<<<BRIEF",
    brief,
    "BRIEF>>>",
    knowledgeBlock(knowledge, learned),
    "",
    "The worker asks you one question:",
    "<<<QUESTION",
    question,
    "QUESTION>>>",
    "",
    "Answer it by these rules, in order:",
    `1. If it asks for a decision listed under USER_CALLS, or any other product decision only the user can make, reply exactly: ${USERS_CALL}`,
    `2. If neither the brief nor WHAT_YOU_KNOW settles it, reply exactly: ${DONT_KNOW} Do not guess at repository contents or invent facts.`,
    "3. Otherwise answer from the brief and WHAT_YOU_KNOW in at most three sentences, stating the fact or grant plainly.",
    "Reply with the answer only, speaking as the parent: name no section of this prompt and none of these rules.",
  ].join("\n");
}

export function reviewPrompt({
  brief,
  knowledge,
  learned,
  report,
}: {
  brief: string;
  knowledge: Knowledge;
  learned: ReadonlySet<number>;
  report: string;
}): string {
  return [
    ROLE,
    "",
    "<<<BRIEF",
    brief,
    "BRIEF>>>",
    knowledgeBlock(knowledge, learned),
    "",
    "The worker finished and sent this final report:",
    "<<<REPORT",
    report,
    "REPORT>>>",
    "",
    "Decide whether to send it back for one more round. Send a directive only when one of these holds:",
    "- the report leaves a question open that WHAT_YOU_KNOW answers;",
    "- the worker stopped at an edge of its authority that WHAT_YOU_KNOW lets you grant;",
    "- the worker reports a blocker that WHAT_YOU_KNOW says you have cleared;",
    "- the work as reported contradicts something in WHAT_YOU_KNOW;",
    "- the report says the brief's acceptance is not met and WHAT_YOU_KNOW gives a way to meet it.",
    "Leave questions under USER_CALLS to the user, and ask for no polish.",
    "",
    "Speak as the parent: name no section of this prompt.",
    "Reply with exactly one line: `ACCEPT`, or `DIRECTIVE: <at most three sentences telling the worker what to do>`.",
  ].join("\n");
}

/** At most three sentences: the parent's answers are short by contract, whatever the model wrote. */
export function clampSentences(text: string): string {
  // A sentence ends at terminal punctuation followed by whitespace, so `docs/api.md` stays whole.
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .slice(0, 3)
    .join(" ");
}

export type Review =
  | { readonly kind: "accept" }
  | { readonly kind: "directive"; readonly text: string };

export function parseReview(reply: string): Review | undefined {
  const line = reply
    .trim()
    .split("\n")
    .findLast((candidate) => /^(ACCEPT|DIRECTIVE:)/.test(candidate.trim()));

  if (line === undefined) return undefined;

  const trimmed = line.trim();

  if (trimmed.startsWith("ACCEPT")) return { kind: "accept" };

  return { kind: "directive", text: clampSentences(trimmed.slice("DIRECTIVE:".length)) };
}

export interface ParentTurn {
  readonly kind: "answer" | "review";
  /** How the question reached the parent: ask-parent, a QUESTION: block, or the final report. */
  readonly via: "ask-parent" | "question-block" | "report";
  readonly elapsedSeconds: number;
  readonly input: string;
  readonly reply: string;
  readonly latencyMs: number;
  readonly costUsd: number | null;
  readonly failure: string | null;
}

export interface Oracle {
  answer(question: string, via: "ask-parent" | "question-block"): Promise<string>;
  review(report: string): Promise<Review>;
}

/**
 * The parent of one run. Each turn waits `latencyMs` first, to model a busy parent, and is
 * appended to `logFile`. A failed model call answers "I don't know" and accepts the report, so a
 * broken parent never invents a directive; the log records the failure.
 */
export function parentOracle({
  brief,
  knowledge,
  model,
  startedAt,
  latencyMs,
  logFile,
  onContact,
  learned,
  now = Date.now,
}: {
  brief: string;
  knowledge: Knowledge;
  model: ParentModel;
  startedAt: number;
  latencyMs: number;
  logFile: string;
  /** Runs after every turn, such as the parent refreshing an expired login. */
  onContact: () => void;
  /** The indexes of the mid-run facts the parent has learned so far. */
  learned: () => ReadonlySet<number>;
  now?: () => number;
}): Oracle {
  const turn = async (
    kind: ParentTurn["kind"],
    via: ParentTurn["via"],
    input: string,
    prompt: (learned: ReadonlySet<number>) => string,
  ) => {
    const asked = now();

    await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const elapsedSeconds = (now() - startedAt) / 1000;
    const completion = await model(prompt(learned()));
    const reply = completion.kind === "answered" ? completion.text : "";

    const entry: ParentTurn = {
      kind,
      via,
      elapsedSeconds,
      input,
      reply,
      latencyMs: now() - asked,
      costUsd: completion.kind === "answered" ? (completion.costUsd ?? null) : null,
      failure: completion.kind === "failed" ? completion.reason : null,
    };

    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    onContact();

    return reply;
  };

  return {
    async answer(question, via) {
      const reply = await turn("answer", via, question, (known) =>
        answerPrompt({ brief, knowledge, learned: known, question }),
      );

      return reply === "" ? DONT_KNOW : clampSentences(reply);
    },
    async review(report) {
      const reply = await turn("review", "report", report, (known) =>
        reviewPrompt({ brief, knowledge, learned: known, report }),
      );

      return parseReview(reply) ?? { kind: "accept" };
    },
  };
}
