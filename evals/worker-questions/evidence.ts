// What the parent sees for itself when it reviews a round, as implement-chunk's parent does: the
// diff at the brief's branch tip, the changed paths against SCOPE, and the repository gate run in
// a fresh clone of the tip. Only what a parent could check by hand, never the graders' conditions.

import { spawnSync } from "node:child_process";
import type { BriefSpec } from "./briefs.ts";
import { covers, onTip, runGate, sh } from "./graders.ts";

/** The diff lines shown before the rest is cut, about what a parent reads in one sitting. */
export const DIFF_LINE_CAP = 400;

const GATE_TAIL_LINES = 40;

export interface ChangedPath {
  readonly path: string;
  readonly inScope: boolean;
}

export type ReviewEvidence =
  | {
      readonly kind: "no-branch";
      readonly branch: string;
      /** `git status --short` of the working directory. */
      readonly uncommitted: string;
    }
  | {
      readonly kind: "tip";
      readonly branch: string;
      readonly diffStat: string;
      /** The first DIFF_LINE_CAP lines of the diff. */
      readonly diff: string;
      readonly cutLines: number;
      readonly changed: readonly ChangedPath[];
      readonly gate: { readonly exit: number | null; readonly tail: string };
      readonly uncommitted: string;
    };

export function reviewEvidence({
  brief,
  baseSha,
  workdir,
}: {
  brief: BriefSpec;
  baseSha: string;
  workdir: string;
}): ReviewEvidence {
  const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: workdir,
    encoding: "utf8",
  });

  // trimEnd: a status line starts with a space for a change not yet staged.
  const uncommitted = (status.stdout ?? "").trimEnd();

  const seen = onTip({ workdir, ghState: undefined }, { brief }, baseSha, (tip): ReviewEvidence => {
    // The clone's `main` is the base, so these are the commands a parent would type.
    const range = "main..HEAD";
    const diffLines = sh(tip.dir, `git diff ${range}`).out.split("\n");
    const gate = runGate(tip);

    return {
      kind: "tip",
      branch: brief.branch,
      diffStat: sh(tip.dir, `git diff --stat ${range}`).out,
      diff: diffLines.slice(0, DIFF_LINE_CAP).join("\n"),
      cutLines: Math.max(0, diffLines.length - DIFF_LINE_CAP),
      changed: sh(tip.dir, `git diff --name-only ${range}`)
        .out.split("\n")
        .filter((path) => path !== "")
        .map((path) => ({ path, inScope: brief.scope.some((entry) => covers(entry, path)) })),
      gate: { exit: gate.exit, tail: gate.out.split("\n").slice(-GATE_TAIL_LINES).join("\n") },
      uncommitted,
    };
  });

  return seen ?? { kind: "no-branch", branch: brief.branch, uncommitted };
}

export function renderEvidence(evidence: ReviewEvidence): string {
  const uncommitted = [
    "Uncommitted changes left in the working directory (`git status --short`):",
    evidence.uncommitted === "" ? "(none)" : evidence.uncommitted,
  ];

  if (evidence.kind === "no-branch")
    return [`The branch ${evidence.branch} does not exist.`, ...uncommitted].join("\n");

  const outside = evidence.changed.filter((item) => !item.inScope).map((item) => item.path);

  return [
    `Branch ${evidence.branch} against main, checked out alone in a fresh clone.`,
    "`git diff --stat main..HEAD`:",
    evidence.diffStat === "" ? "(no commits beyond main)" : evidence.diffStat,
    "",
    "The diff:",
    evidence.diff,
    ...(evidence.cutLines > 0
      ? [`[diff truncated: ${evidence.cutLines} more lines not shown]`]
      : []),
    "",
    outside.length === 0
      ? "Every changed path is inside SCOPE."
      : `Changed paths outside SCOPE: ${outside.join(", ")}`,
    "",
    `\`sh scripts/check.sh\` at the tip exited ${evidence.gate.exit ?? "without a status (killed or timed out)"}. The last lines of its output:`,
    evidence.gate.tail,
    "",
    ...uncommitted,
  ].join("\n");
}
