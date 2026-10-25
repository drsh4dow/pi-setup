// The LLM judge for metrics that need judgment: one `pi -p` call without tools, skills, session,
// or project context per question, answering one JSON line. Answers are cached by the prompt's
// hash in the run's judge.json, so regrading never calls the judge again for the same question
// and material. A judge that could not answer is "unavailable", never a pass or a fail, and is
// not cached, so the next grade retries it.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Option, Schema } from "effect";
import { candidateEnv, writeAtomically } from "../lib/pi-run.ts";
import { gemini, type GeminiPart } from "./gemini.ts";
import { flag, truncate, unknown, type FlagMetric } from "./metrics.ts";

export interface JudgeRequest {
  readonly question: string;
  readonly finalText: string;
  /** Only the material the question needs, each under a label. */
  readonly artifacts: readonly { readonly label: string; readonly text: string }[];
  /** PNG files the judge looks at, in the order the prompt lists them. */
  readonly images?: readonly string[];
}

export type JudgeAnswer =
  | { readonly kind: "answered"; readonly pass: boolean; readonly why: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export type Judge = (request: JudgeRequest) => Promise<JudgeAnswer>;

const ARTIFACT_LIMIT = 30_000;

export function judgePrompt(request: JudgeRequest): string {
  const artifacts = request.artifacts.map(
    ({ label, text }) => `<<<${label}\n${truncate(text, ARTIFACT_LIMIT)}\n${label}>>>`,
  );

  const images = request.images ?? [];

  return [
    "You grade one run of a coding agent against a single yes-or-no question. Judge only from the material below, not from what the agent should have done.",
    ...(images.length === 0
      ? []
      : [
          "",
          `${images.length} images are attached, in this order: ${images.map((path, index) => `${index + 1}. ${basename(path)}`).join(", ")}.`,
        ]),
    "",
    `Question: ${request.question}`,
    "",
    "<<<FINAL_MESSAGE",
    truncate(request.finalText, ARTIFACT_LIMIT),
    "FINAL_MESSAGE>>>",
    ...artifacts,
    "",
    'Reply with one line of JSON and nothing else: {"pass": true or false, "why": "<one sentence citing the material>"}',
  ].join("\n");
}

const Answer = Schema.Struct({ pass: Schema.Boolean, why: Schema.String });

const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Answer));

/** The answer in a reply that may wrap its JSON line in prose or a code fence. */
export function parseAnswer(reply: string): JudgeAnswer {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");

  if (start === -1 || end < start)
    return { kind: "unavailable", reason: `no JSON in reply: ${truncate(reply, 200)}` };

  const answer = decodeAnswer(reply.slice(start, end + 1));

  if (Option.isNone(answer))
    return { kind: "unavailable", reason: `malformed reply: ${truncate(reply, 200)}` };

  return { kind: "answered", pass: answer.value.pass, why: answer.value.why };
}

const JUDGE_TIMEOUT_MS = 5 * 60_000;

/** The judge as one isolated `pi -p` call per question. */
export function piJudge(model: string): Judge {
  return (request) =>
    new Promise((resolve) => {
      const child = execFile(
        "pi",
        [
          "-p",
          "--no-session",
          "--no-tools",
          "--no-skills",
          "--no-extensions",
          "--no-mcp",
          "--no-context-files",
          "--no-prompt-templates",
          "--model",
          model,
          "--thinking",
          "low",
          ...(request.images ?? []).map((path) => `@${path}`),
          judgePrompt(request),
        ],
        {
          cwd: mkdtempSync(join(tmpdir(), "judge-")),
          env: candidateEnv(),
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          timeout: JUDGE_TIMEOUT_MS,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              kind: "unavailable",
              reason: `pi failed: ${truncate(stderr || error.message, 300)}`,
            });

            return;
          }

          resolve(parseAnswer(stdout));
        },
      );

      // `pi -p` waits for piped stdin to end before it runs, and execFile leaves stdin an open pipe.
      child.stdin?.end();
    });
}

/** The judge as one call to the Gemini API per question, with the images inline. */
export function geminiJudge(model: string): Judge {
  return async (request) => {
    const images: GeminiPart[] = (request.images ?? []).map((path) => ({
      inlineData: { mimeType: "image/png", data: readFileSync(path).toString("base64") },
    }));

    const reply = await gemini(model, [...images, { text: judgePrompt(request) }]);

    return reply.kind === "text"
      ? parseAnswer(reply.text)
      : { kind: "unavailable", reason: `gemini failed: ${reply.reason}` };
  };
}

/** The models `GEMINI_PREFIX` names go straight to the Gemini API; the rest go through `pi -p`. */
export const GEMINI_PREFIX = "gemini-api/";

export function judgeFor(model: string): Judge {
  return model.startsWith(GEMINI_PREFIX)
    ? geminiJudge(model.slice(GEMINI_PREFIX.length))
    : piJudge(model);
}

const Cache = Schema.Record(
  Schema.String,
  Schema.Struct({
    question: Schema.String,
    model: Schema.String,
    pass: Schema.Boolean,
    why: Schema.String,
  }),
);

const decodeCache = Schema.decodeUnknownSync(Schema.fromJsonString(Cache));

/**
 * `judge` with its answers kept in `file`, keyed by the prompt's hash and the model, so the same
 * question over the same material is asked once. Unavailable answers are not kept.
 */
export function cachedJudge({
  judge,
  model,
  file,
}: {
  judge: Judge;
  model: string;
  file: string;
}): Judge {
  return async (request) => {
    const hash = createHash("sha256").update(model).update("\0").update(judgePrompt(request));

    for (const image of request.images ?? []) hash.update("\0").update(readFileSync(image));

    const key = hash.digest("hex");

    const cache = existsSync(file) ? decodeCache(readFileSync(file, "utf8")) : {};
    const hit = cache[key];

    if (hit !== undefined) return { kind: "answered", pass: hit.pass, why: hit.why };

    const answer = await judge(request);

    if (answer.kind === "answered") {
      // Reread: another question of the same run may have been answered meanwhile.
      const latest = existsSync(file) ? decodeCache(readFileSync(file, "utf8")) : {};
      const entry = { question: request.question, model, pass: answer.pass, why: answer.why };

      writeAtomically(file, `${JSON.stringify({ ...latest, [key]: entry }, null, 2)}\n`);
    }

    return answer;
  };
}

/** `judge` with every occurrence of `secret` in the material replaced, so no path names the arm. */
export function redactingJudge(judge: Judge, secret: string, replacement: string): Judge {
  const redact = (text: string) => text.replaceAll(secret, replacement);

  return (request) =>
    judge({
      question: request.question,
      finalText: redact(request.finalText),
      artifacts: request.artifacts.map(({ label, text }) => ({ label, text: redact(text) })),
      images: request.images,
    });
}

/** A judge answer as a metric: its verdict and reason, or unknown when the judge could not run. */
export function judged(answer: JudgeAnswer): FlagMetric {
  if (answer.kind === "unavailable") return unknown(`judge unavailable: ${answer.reason}`);

  return flag(answer.pass, answer.why);
}
