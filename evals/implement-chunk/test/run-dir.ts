// Synthetic run directories the way `run.ts` leaves them, minus the archived origin, for the
// grader's tests: sessions, run.json with its integrity record, gh and tracker state, drive.json.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { initialFakeGitHub, type PullRequest } from "../gh-state.ts";

const scratch = mkdtempSync(join(tmpdir(), "ic-run-dir-"));

after(() => rmSync(scratch, { recursive: true, force: true }));

export const ARM_PROMPT = "You are the arm's harness.";

export const ARM_APPENDIX = "# Subagent run\nThe arm's appendix.";

export const LIVE_APPENDIX = "# Subagent run\nThe live appendix.";

export interface SessionSpec {
  readonly cwd: string;
  readonly agentDir: string;
  readonly preamble?: string;
  readonly addendum?: string;
  readonly name?: string;
  readonly cost?: number;
  readonly calls?: readonly { readonly name: string; readonly arguments: Record<string, string> }[];
  readonly texts?: readonly string[];
}

export function sessionJsonl(spec: SessionSpec): string {
  const lines: unknown[] = [
    { type: "session", version: 3, id: "s", timestamp: "2026-10-24T10:00:00.000Z", cwd: spec.cwd },
    {
      type: "message",
      message: {
        role: "system",
        sections: {
          preamble: spec.preamble ?? ARM_PROMPT,
          addendum: spec.addendum ?? "",
          skills: `<location>${spec.agentDir}/skills/subagents/SKILL.md</location>`,
        },
      },
    },
  ];

  if (spec.name !== undefined) lines.push({ type: "session_info", name: spec.name });

  lines.push({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: spec.name ?? "Implement chunk" }] },
  });

  for (const [index, call] of (spec.calls ?? []).entries()) {
    lines.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: `c${index}`, name: call.name, arguments: call.arguments },
        ],
        usage: { cost: { total: 0 } },
      },
    });
    lines.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `c${index}`,
        content: [{ type: "text", text: "" }],
        isError: false,
      },
    });
  }

  for (const text of spec.texts ?? ["Done."]) {
    lines.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: { cost: { total: spec.cost ?? 0 } },
      },
    });
  }

  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export interface RunSpec {
  readonly arm: string;
  readonly trial: number;
  readonly childAddendum: string;
  readonly humanTurns: readonly ("intake" | "nudge" | "re-ask")[];
  readonly resets: number;
  /** Branches the arm's repository gained during the run. */
  readonly addedBranches?: readonly string[];
  /** Leave out the integrity record, as runs before the check did. */
  readonly noIntegrity?: boolean;
  readonly childCalls?: SessionSpec["calls"];
  /** The chunk's final PRs the driver froze, recorded in drive.json. */
  readonly chunkFinalPrs?: readonly number[];
}

export const SOURCES = {
  at: "2026-10-24T10:00:00.000Z",
  armHead: "abc",
  armStatus: [],
  armDigest: "d",
  armBranches: ["main", "implement-chunk-revise"],
  liveAgentStatus: [],
  liveBranches: ["main", "implement-chunk-revise"],
  copyDigest: "d",
};

/** Writes a finished run directory the way `run.ts` leaves one, minus the archived origin. */
export function writeRun(out: string, spec: RunSpec): string {
  const dir = join(out, spec.arm, `t${spec.trial}`);
  const runScratch = join(scratch, `${spec.arm}-${spec.trial}`);
  const cwd = join(runScratch, "tally");
  const agentDir = join(runScratch, "home", ".pi", "agent");

  mkdirSync(join(dir, "harness", "subagents"), { recursive: true });
  mkdirSync(join(dir, "harness", "live-subagents"), { recursive: true });
  mkdirSync(join(dir, "sessions", "child"), { recursive: true });
  writeFileSync(join(dir, "harness", "SYSTEM.md"), ARM_PROMPT);
  writeFileSync(join(dir, "harness", "subagents", "unattended.md"), ARM_APPENDIX);
  writeFileSync(join(dir, "harness", "live-subagents", "unattended.md"), LIVE_APPENDIX);

  const record = {
    arm: { name: spec.arm, root: "/arm", head: "abc" },
    trial: spec.trial,
    agentDir,
  };

  const integrity = {
    armEntries: ["SYSTEM.md", "skills", "prompts"],
    before: SOURCES,
    after: { ...SOURCES, armBranches: [...SOURCES.armBranches, ...(spec.addedBranches ?? [])] },
  };

  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify(spec.noIntegrity === true ? record : { ...record, integrity }),
  );
  writeFileSync(
    join(dir, "root.jsonl"),
    sessionJsonl({
      cwd,
      agentDir,
      cost: 2,
      calls: [
        {
          name: "bg_start",
          arguments: {
            command: "pi-subagent --append-system-prompt unattended.md 'Implement TAL-2'",
          },
        },
        { name: "write", arguments: { path: join(cwd, "src", "app.mjs"), content: "x" } },
      ],
    }),
  );
  writeFileSync(
    join(dir, "sessions", "child", "a.jsonl"),
    sessionJsonl({
      cwd: join(runScratch, "wt", "u1"),
      agentDir,
      addendum: spec.childAddendum,
      name: "implement TAL-2",
      cost: 3,
      calls: spec.childCalls,
    }),
  );
  writeFileSync(
    join(dir, "gh-state.json"),
    JSON.stringify(
      initialFakeGitHub({
        owner: "acme",
        repo: "tally",
        bare: "/nonexistent",
        ciDelayMs: 0,
        botDelayMs: 0,
      }),
    ),
  );

  const tracker = Array.from({ length: spec.resets }, (_, index) => [
    {
      at: `2026-10-24T10:0${index}:00.000Z`,
      actor: "github",
      argv: ["pr-merged", "1"],
      changes: [{ key: "TAL-2", from: "In Progress", to: "Done" }],
      error: null,
    },
    {
      at: `2026-10-24T10:0${index}:30.000Z`,
      actor: "agent",
      argv: ["state", "TAL-2", "In Progress"],
      changes: [{ key: "TAL-2", from: "Done", to: "In Progress" }],
      error: null,
    },
  ]).flat();

  writeFileSync(
    join(dir, "tracker-log.jsonl"),
    tracker.map((entry) => JSON.stringify(entry)).join("\n"),
  );
  writeFileSync(
    join(dir, "drive.json"),
    JSON.stringify({
      startedAt: "2026-10-24T10:00:00.000Z",
      endedAt: "2026-10-24T11:00:00.000Z",
      wallMs: 3_600_000,
      stop: "max turns",
      piTurns: [],
      humanTurns: spec.humanTurns.map((reason) => ({
        at: "2026-10-24T10:30:00.000Z",
        reason,
        answering: "",
        reply: "",
      })),
      humanMerges: [],
      rootSession: null,
      // JSON drops an undefined key, as in records from before the chunk scope.
      chunkFinalPrs:
        spec.chunkFinalPrs === undefined
          ? undefined
          : {
              numbers: spec.chunkFinalPrs,
              source: "plan.md",
              closedAt: "2026-10-24T10:40:00.000Z",
            },
    }),
  );

  return dir;
}

/** A merged PR into `main`, numbered, with head branch `b<number>`. */
export function mergedPullRequest(number: number): PullRequest {
  return {
    number,
    title: "t",
    body: "",
    author: "sam-rivera",
    headRefName: `b${number}`,
    baseRefName: "main",
    headRefOid: "0",
    state: "MERGED",
    isDraft: false,
    createdAt: "2026-10-24T10:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    mergedBy: "human",
    mergeCommit: null,
    heads: [],
    comments: [],
  };
}
