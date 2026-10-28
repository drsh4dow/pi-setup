// What the grader knows about a graded chunk: its sessions, where each sits in the launch tree,
// and the findings, one row per counted event.

import type { ToolOperation } from "../lib/session.ts";
import type { Kind, Launch, UncountedLaunch } from "./launches.ts";

export const FINDING_CLASSES = [
  "skill-read",
  "launch",
  "wrong-spawn",
  "root-edit",
  "stale-verdict",
  "report-only-merge",
  "unterminated-subagent",
] as const;

export type FindingClass = (typeof FINDING_CLASSES)[number];

export interface Finding {
  readonly session: string;
  /** The session entry the finding points to, or `-` when none records it. */
  readonly entry: string;
  readonly findingClass: FindingClass;
  readonly detail: string;
}

export type Mode = "general" | "sh4dow" | "subagent";

/** Where a session sits in the launch tree: the coordinator at the root, or a subagent of a kind. */
export type Position = { readonly at: "root" } | { readonly at: "subagent"; readonly kind: Kind };

export interface Chunk {
  readonly dir: string;
  readonly project: string;
  readonly name: string;
}

export interface GradedSession {
  readonly id: string;
  readonly file: string;
  readonly chunk: Chunk;
  readonly mode: Mode;
  readonly role: string;
  readonly position: Position;
  readonly parent: string | undefined;
  readonly depth: number;
  readonly skillTable: string;
  readonly operations: readonly ToolOperation[];
  readonly launches: readonly Launch[];
  /** Calls that may have launched, left out of `launches` because their command is cut. */
  readonly uncountedLaunches: readonly UncountedLaunch[];
  readonly finalText: string;
}

export interface ChunkGrade {
  readonly chunk: Chunk;
  readonly sessions: readonly GradedSession[];
  readonly findings: readonly Finding[];
  /** Launches whose child session no record names, so the tree below them is not graded. */
  readonly unlinkedLaunches: number;
}
