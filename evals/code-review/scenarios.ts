import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

export const Lens = Schema.Literals([
  "spec-fidelity",
  "standards",
  "logical-proof",
  "simplifier",
  "reader",
  "comment-sicko",
  "unslop",
  "security",
  "tests",
]);

export type Lens = typeof Lens.Type;

export const Defect = Schema.Struct({
  id: Schema.String,
  lens: Lens,
  file: Schema.String,
  lines: Schema.Tuple([Schema.Int, Schema.Int]),
  summary: Schema.String,
  proof: Schema.optionalKey(Schema.String),
});

export type Defect = typeof Defect.Type;

export const GroundTruth = Schema.Struct({
  commitMessage: Schema.String,
  spec: Schema.String,
  defects: Schema.Array(Defect),
});

export type GroundTruth = typeof GroundTruth.Type;

const decodeGroundTruth = Schema.decodeUnknownSync(Schema.fromJsonString(GroundTruth));

export const ARMS = ["plain", "code-review"] as const;

export type Arm = (typeof ARMS)[number];

const AWAY =
  "I'm away from the keyboard and can't answer questions, so don't stop to ask. Report your review as your final message.";

/** The request each arm sends. Every arm gets the same spec and the same branch. */
export function prompt(arm: Arm, spec: string): string {
  const context = `The spec for this branch:\n\n${spec}\n\n${AWAY}`;

  const request: Record<Arm, string> = {
    plain:
      "Review the changes on this branch against main. Report the problems you find, worst first.",
    "code-review": "/skill:code-review main",
  };

  return `${request[arm]}\n\n${context}`;
}

export interface Fixture {
  readonly name: string;
  readonly truth: GroundTruth;
}

export function loadFixtures(evalDir: string): Fixture[] {
  return readdirSync(join(evalDir, "defects"))
    .filter((file) => file.endsWith(".json"))
    .toSorted()
    .map((file) => ({
      name: file.replace(/\.json$/, ""),
      truth: decodeGroundTruth(readFileSync(join(evalDir, "defects", file), "utf8")),
    }));
}
