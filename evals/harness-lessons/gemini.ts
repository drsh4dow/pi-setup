// One call to the Gemini API: text, audio, and images in, text out. The grade uses it to
// transcribe a video's narration and, through `geminiJudge` in judge.ts, to judge frames. The key
// comes from GEMINI_API_KEY and travels only in a request header, never in a URL, log, or error.

import { Option, Schema } from "effect";
import { truncate } from "./metrics.ts";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiPart =
  | { readonly text: string }
  | { readonly inlineData: { readonly mimeType: string; readonly data: string } };

export type GeminiReply =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "failed"; readonly reason: string };

const Response = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      content: Schema.Struct({
        parts: Schema.Array(
          Schema.Struct({
            text: Schema.optionalKey(Schema.String),
            audioTranscription: Schema.optionalKey(Schema.Struct({ text: Schema.String })),
          }),
        ),
      }),
    }),
  ),
});

const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(Response));

const TIMEOUT_MS = 5 * 60_000;

/** The text Gemini `model` answers `parts` with, or why it could not. */
export async function gemini(model: string, parts: readonly GeminiPart[]): Promise<GeminiReply> {
  const key = process.env.GEMINI_API_KEY;

  if (key === undefined || key === "") return { kind: "failed", reason: "GEMINI_API_KEY is unset" };

  try {
    const response = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await response.text();

    if (!response.ok)
      return { kind: "failed", reason: `HTTP ${response.status}: ${truncate(body, 300)}` };

    const decoded = decodeResponse(body);

    if (Option.isNone(decoded))
      return { kind: "failed", reason: `unexpected reply: ${truncate(body, 300)}` };

    const text = (decoded.value.candidates[0]?.content.parts ?? [])
      .map((part) => part.audioTranscription?.text ?? part.text ?? "")
      .join("")
      .trim();

    return text === "" ? { kind: "failed", reason: "empty reply" } : { kind: "text", text };
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
