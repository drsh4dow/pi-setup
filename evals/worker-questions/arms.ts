// The arms: communication protocols, each a configuration of the same harness checkout. An arm
// picks the brief variant, the subagent prompt it appends (the shared subagent part
// agent/system/subagent.md, or an overlay), the tools on PATH, the push extension, and how a
// review directive reaches the worker.

import { dirname, join } from "node:path";
import type { BriefVariant } from "./briefs.ts";
import type { ArmId } from "./scenario.ts";

const HERE = dirname(new URL(import.meta.url).pathname);

export interface Arm {
  readonly id: ArmId;
  readonly brief: BriefVariant;
  /** The subagent prompt it appends: the shared subagent part under the harness root, or an overlay in this folder. */
  readonly protocol:
    | { readonly kind: "harness"; readonly path: string }
    | { readonly kind: "overlay"; readonly path: string };
  readonly askParent: boolean;
  /** Ends a turn on a `QUESTION:` block and is resumed with the answer. */
  readonly questionBlocks: boolean;
  readonly push: boolean;
  /** A directive goes to a fresh worker with the brief and prior report, or resumes the session. */
  readonly followUp: "fresh" | "resume";
}

const SUBAGENT_PART = {
  kind: "harness",
  path: join("agent", "system", "subagent.md"),
} as const;

export const ARMS: Readonly<Record<ArmId, Arm>> = {
  A: {
    id: "A",
    brief: "today",
    protocol: SUBAGENT_PART,
    askParent: false,
    questionBlocks: false,
    push: false,
    followUp: "fresh",
  },
  C: {
    id: "C",
    brief: "hardened",
    protocol: SUBAGENT_PART,
    askParent: false,
    questionBlocks: false,
    push: false,
    followUp: "fresh",
  },
  R: {
    id: "R",
    brief: "hardened",
    protocol: { kind: "overlay", path: join(HERE, "overlays", "resume-question.md") },
    askParent: false,
    questionBlocks: true,
    push: false,
    followUp: "resume",
  },
  L: {
    id: "L",
    brief: "hardened",
    protocol: { kind: "overlay", path: join(HERE, "overlays", "ask-parent.md") },
    askParent: true,
    questionBlocks: false,
    push: false,
    followUp: "fresh",
  },
  "C+push": {
    id: "C+push",
    brief: "hardened",
    protocol: SUBAGENT_PART,
    askParent: false,
    questionBlocks: false,
    push: true,
    followUp: "fresh",
  },
};

export function protocolFile(arm: Arm, harness: string): string {
  return arm.protocol.kind === "harness" ? join(harness, arm.protocol.path) : arm.protocol.path;
}

export const delegateFile = (harness: string) =>
  join(harness, "agent", "system", "kinds", "delegate.md");

export const PUSH_EXTENSION = join(HERE, "push-extension.ts");

export const EVAL_BIN = join(HERE, "bin");

/** A worker ends on at most this many `QUESTION:` blocks before its next one goes unanswered. */
export const MAX_QUESTION_RESUMES = 3;
